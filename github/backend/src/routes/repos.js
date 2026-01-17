import { Router } from 'express';
import { query } from '../db/index.js';
import * as gitService from '../services/git.js';
import * as searchService from '../services/search.js';
import { requireAuth } from '../middleware/auth.js';

// Import shared modules
import logger from '../shared/logger.js';
import { auditLog, AUDITED_ACTIONS } from '../shared/audit.js';
import {
  getRepoFromCache,
  setRepoInCache,
  invalidateRepoCache,
  getTreeFromCache,
  setTreeInCache,
  getBranchesFromCache,
  setBranchesInCache,
  getCommitsFromCache,
  setCommitsInCache,
  getFileFromCache,
  setFileInCache,
  invalidateRepoCaches,
  invalidatePRCaches,
} from '../shared/cache.js';
import { withCircuitBreaker } from '../shared/circuitBreaker.js';
import { pushesTotal } from '../shared/metrics.js';

const router = Router();

/**
 * List repositories
 */
router.get('/', async (req, res) => {
  const { owner, page = 1, limit = 20, sort = 'updated_at' } = req.query;

  const offset = (parseInt(page) - 1) * parseInt(limit);

  let whereClause = 'WHERE r.is_private = FALSE';
  const params = [];

  if (owner) {
    params.push(owner);
    whereClause += ` AND u.username = $${params.length}`;
  }

  // Include private repos if user is authenticated and is the owner
  if (req.user) {
    params.push(req.user.id);
    whereClause += ` OR r.owner_id = $${params.length}`;
  }

  const countResult = await query(
    `SELECT COUNT(*) FROM repositories r
     LEFT JOIN users u ON r.owner_id = u.id
     ${whereClause}`,
    params
  );

  const sortColumn = ['updated_at', 'created_at', 'stars_count', 'name'].includes(sort) ? sort : 'updated_at';

  const result = await query(
    `SELECT r.*, u.username as owner_name, u.avatar_url as owner_avatar
     FROM repositories r
     LEFT JOIN users u ON r.owner_id = u.id
     ${whereClause}
     ORDER BY r.${sortColumn} DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, parseInt(limit), offset]
  );

  res.json({
    repos: result.rows,
    total: parseInt(countResult.rows[0].count),
    page: parseInt(page),
    limit: parseInt(limit),
  });
});

/**
 * Get single repository (with caching)
 */
router.get('/:owner/:repo', async (req, res) => {
  const { owner, repo } = req.params;

  // First, get repo ID for cache lookup
  const repoIdResult = await query(
    `SELECT r.id FROM repositories r
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2`,
    [owner, repo]
  );

  if (repoIdResult.rows.length === 0) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  const repoId = repoIdResult.rows[0].id;

  // Try cache first
  let repoData = await getRepoFromCache(repoId);

  if (!repoData) {
    // Cache miss - fetch from database
    const result = await query(
      `SELECT r.*, u.username as owner_name, u.avatar_url as owner_avatar,
              u.display_name as owner_display_name
       FROM repositories r
       LEFT JOIN users u ON r.owner_id = u.id
       WHERE r.id = $1`,
      [repoId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Repository not found' });
    }

    repoData = result.rows[0];

    // Store in cache
    await setRepoInCache(repoId, repoData);
  }

  // Check access
  if (repoData.is_private && (!req.user || req.user.id !== repoData.owner_id)) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  // Get branches (with caching)
  let branches = await getBranchesFromCache(repoId);
  if (!branches) {
    branches = await withCircuitBreaker('git_branches', () =>
      gitService.getBranches(owner, repo)
    );
    await setBranchesInCache(repoId, branches);
  }

  // Get tags
  const tags = await withCircuitBreaker('git_tags', () =>
    gitService.getTags(owner, repo)
  );

  res.json({
    ...repoData,
    branches,
    tags,
  });
});

/**
 * Create repository
 */
router.post('/', requireAuth, async (req, res) => {
  const { name, description, isPrivate, initWithReadme } = req.body;

  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid repository name' });
  }

  try {
    // Check if repo exists
    const existing = await query(
      'SELECT id FROM repositories WHERE owner_id = $1 AND name = $2',
      [req.user.id, name]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Repository already exists' });
    }

    // Initialize git repository
    const storagePath = await gitService.initRepository(req.user.username, name);

    // Create database record
    const result = await query(
      `INSERT INTO repositories (owner_id, name, description, is_private, storage_path)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.user.id, name, description || null, isPrivate || false, storagePath]
    );

    const repo = result.rows[0];

    // Initialize with README if requested
    if (initWithReadme) {
      await gitService.initWithReadme(req.user.username, name, description || '');
    }

    // Create default labels
    const defaultLabels = [
      { name: 'bug', color: '#d73a4a', description: 'Something is not working' },
      { name: 'enhancement', color: '#a2eeef', description: 'New feature or request' },
      { name: 'documentation', color: '#0075ca', description: 'Improvements to documentation' },
      { name: 'good first issue', color: '#7057ff', description: 'Good for newcomers' },
    ];

    for (const label of defaultLabels) {
      await query(
        'INSERT INTO labels (repo_id, name, color, description) VALUES ($1, $2, $3, $4)',
        [repo.id, label.name, label.color, label.description]
      );
    }

    // Audit log
    await auditLog(
      AUDITED_ACTIONS.REPO_CREATE,
      'repository',
      repo.id,
      { name, isPrivate, initWithReadme },
      req
    );

    res.status(201).json(repo);
  } catch (err) {
    req.log?.error({ err }, 'Create repo error');
    res.status(500).json({ error: 'Failed to create repository' });
  }
});

/**
 * Update repository
 */
router.patch('/:owner/:repo', requireAuth, async (req, res) => {
  const { owner, repo } = req.params;
  const { description, isPrivate, defaultBranch } = req.body;

  // Get repo and verify ownership
  const repoResult = await query(
    `SELECT r.* FROM repositories r
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2`,
    [owner, repo]
  );

  if (repoResult.rows.length === 0) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  if (repoResult.rows[0].owner_id !== req.user.id) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  const updates = [];
  const params = [];
  const changes = {};

  if (description !== undefined) {
    params.push(description);
    updates.push(`description = $${params.length}`);
    changes.description = description;
  }
  if (isPrivate !== undefined) {
    params.push(isPrivate);
    updates.push(`is_private = $${params.length}`);
    changes.isPrivate = isPrivate;
  }
  if (defaultBranch !== undefined) {
    params.push(defaultBranch);
    updates.push(`default_branch = $${params.length}`);
    changes.defaultBranch = defaultBranch;
  }

  if (updates.length === 0) {
    return res.json(repoResult.rows[0]);
  }

  params.push(new Date());
  updates.push(`updated_at = $${params.length}`);

  params.push(repoResult.rows[0].id);

  const result = await query(
    `UPDATE repositories SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );

  // Invalidate cache
  await invalidateRepoCache(repoResult.rows[0].id);

  // Audit log
  const action = isPrivate !== undefined ? AUDITED_ACTIONS.REPO_VISIBILITY_CHANGE : AUDITED_ACTIONS.REPO_SETTINGS_CHANGE;
  await auditLog(action, 'repository', repoResult.rows[0].id, changes, req);

  res.json(result.rows[0]);
});

/**
 * Delete repository
 */
router.delete('/:owner/:repo', requireAuth, async (req, res) => {
  const { owner, repo } = req.params;

  const repoResult = await query(
    `SELECT r.* FROM repositories r
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2`,
    [owner, repo]
  );

  if (repoResult.rows.length === 0) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  if (repoResult.rows[0].owner_id !== req.user.id) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  try {
    const repoId = repoResult.rows[0].id;

    // Delete git repository
    await gitService.deleteRepository(owner, repo);

    // Remove from search index
    await searchService.removeRepositoryIndex(repoId);

    // Delete from database (cascade will handle related records)
    await query('DELETE FROM repositories WHERE id = $1', [repoId]);

    // Invalidate all caches for this repo
    await invalidateRepoCaches(repoId);

    // Audit log
    await auditLog(
      AUDITED_ACTIONS.REPO_DELETE,
      'repository',
      repoId,
      { name: repo, owner },
      req
    );

    res.json({ success: true });
  } catch (err) {
    req.log?.error({ err }, 'Delete repo error');
    res.status(500).json({ error: 'Failed to delete repository' });
  }
});

/**
 * Get repository tree (with caching and circuit breaker)
 */
router.get('/:owner/:repo/tree/:ref(*)', async (req, res) => {
  const { owner, repo, ref } = req.params;
  const { path: treePath = '' } = req.query;

  // Get repo ID for caching
  const repoIdResult = await query(
    `SELECT r.id FROM repositories r
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2`,
    [owner, repo]
  );

  if (repoIdResult.rows.length === 0) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  const repoId = repoIdResult.rows[0].id;

  // Try cache first
  let tree = await getTreeFromCache(repoId, ref, treePath);

  if (!tree) {
    // Cache miss - fetch with circuit breaker
    tree = await withCircuitBreaker('git_tree', () =>
      gitService.getTree(owner, repo, ref, treePath)
    );

    // Cache the result
    await setTreeInCache(repoId, ref, treePath, tree);
  }

  res.json(tree);
});

/**
 * Get file content (with caching and circuit breaker)
 */
router.get('/:owner/:repo/blob/:ref/:path(*)', async (req, res) => {
  const { owner, repo, ref, path: filePath } = req.params;

  // Get repo ID for caching
  const repoIdResult = await query(
    `SELECT r.id FROM repositories r
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2`,
    [owner, repo]
  );

  if (repoIdResult.rows.length === 0) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  const repoId = repoIdResult.rows[0].id;

  // Try cache first
  let content = await getFileFromCache(repoId, ref, filePath);

  if (content === null) {
    // Cache miss - fetch with circuit breaker
    content = await withCircuitBreaker('git_file', () =>
      gitService.getFileContent(owner, repo, ref, filePath)
    );

    if (content === null) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Cache the content
    await setFileInCache(repoId, ref, filePath, content);
  }

  res.json({ path: filePath, content });
});

/**
 * Get commits (with caching and circuit breaker)
 */
router.get('/:owner/:repo/commits', async (req, res) => {
  const { owner, repo } = req.params;
  const { branch = 'HEAD', page = 1, limit = 30 } = req.query;

  // Get repo ID for caching
  const repoIdResult = await query(
    `SELECT r.id FROM repositories r
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2`,
    [owner, repo]
  );

  if (repoIdResult.rows.length === 0) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  const repoId = repoIdResult.rows[0].id;

  // Try cache first
  let commits = await getCommitsFromCache(repoId, branch, page);

  if (!commits) {
    // Cache miss - fetch with circuit breaker
    const skip = (parseInt(page) - 1) * parseInt(limit);
    commits = await withCircuitBreaker('git_commits', () =>
      gitService.getCommits(owner, repo, {
        branch,
        maxCount: parseInt(limit),
        skip,
      })
    );

    // Cache the result
    await setCommitsInCache(repoId, branch, page, commits);
  }

  res.json(commits);
});

/**
 * Get single commit
 */
router.get('/:owner/:repo/commit/:sha', async (req, res) => {
  const { owner, repo, sha } = req.params;

  const commit = await withCircuitBreaker('git_commit', () =>
    gitService.getCommit(owner, repo, sha)
  );

  if (!commit) {
    return res.status(404).json({ error: 'Commit not found' });
  }

  res.json(commit);
});

/**
 * Get branches (with caching)
 */
router.get('/:owner/:repo/branches', async (req, res) => {
  const { owner, repo } = req.params;

  // Get repo ID for caching
  const repoIdResult = await query(
    `SELECT r.id FROM repositories r
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2`,
    [owner, repo]
  );

  if (repoIdResult.rows.length === 0) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  const repoId = repoIdResult.rows[0].id;

  // Try cache first
  let branches = await getBranchesFromCache(repoId);

  if (!branches) {
    branches = await withCircuitBreaker('git_branches', () =>
      gitService.getBranches(owner, repo)
    );
    await setBranchesInCache(repoId, branches);
  }

  res.json(branches);
});

/**
 * Get tags
 */
router.get('/:owner/:repo/tags', async (req, res) => {
  const { owner, repo } = req.params;
  const tags = await withCircuitBreaker('git_tags', () =>
    gitService.getTags(owner, repo)
  );
  res.json(tags);
});

/**
 * Handle push event (webhook endpoint for cache invalidation)
 * This would typically be called by git hooks
 */
router.post('/:owner/:repo/push', requireAuth, async (req, res) => {
  const { owner, repo } = req.params;
  const { branch, commits } = req.body;

  // Get repo and verify access
  const repoResult = await query(
    `SELECT r.id, r.owner_id FROM repositories r
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2`,
    [owner, repo]
  );

  if (repoResult.rows.length === 0) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  const repoId = repoResult.rows[0].id;

  // Invalidate all repository caches
  await invalidateRepoCaches(repoId);

  // Find open PRs that might be affected
  const openPRs = await query(
    `SELECT id FROM pull_requests
     WHERE repo_id = $1 AND state = 'open'
     AND (head_branch = $2 OR base_branch = $2)`,
    [repoId, branch]
  );

  // Invalidate PR caches
  await invalidatePRCaches(openPRs.rows.map(pr => pr.id));

  // Update metrics
  pushesTotal.inc({ status: 'success' });

  req.log?.info({ repoId, branch, commitCount: commits?.length }, 'Push received, caches invalidated');

  res.json({ success: true, invalidatedPRs: openPRs.rows.length });
});

/**
 * Star a repository
 */
router.post('/:owner/:repo/star', requireAuth, async (req, res) => {
  const { owner, repo } = req.params;

  const repoResult = await query(
    `SELECT r.id FROM repositories r
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2`,
    [owner, repo]
  );

  if (repoResult.rows.length === 0) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  const repoId = repoResult.rows[0].id;

  await query(
    `INSERT INTO stars (user_id, repo_id) VALUES ($1, $2)
     ON CONFLICT (user_id, repo_id) DO NOTHING`,
    [req.user.id, repoId]
  );

  await query(
    'UPDATE repositories SET stars_count = (SELECT COUNT(*) FROM stars WHERE repo_id = $1) WHERE id = $1',
    [repoId]
  );

  // Invalidate repo cache since stars count changed
  await invalidateRepoCache(repoId);

  res.json({ starred: true });
});

/**
 * Unstar a repository
 */
router.delete('/:owner/:repo/star', requireAuth, async (req, res) => {
  const { owner, repo } = req.params;

  const repoResult = await query(
    `SELECT r.id FROM repositories r
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2`,
    [owner, repo]
  );

  if (repoResult.rows.length === 0) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  const repoId = repoResult.rows[0].id;

  await query('DELETE FROM stars WHERE user_id = $1 AND repo_id = $2', [req.user.id, repoId]);

  await query(
    'UPDATE repositories SET stars_count = (SELECT COUNT(*) FROM stars WHERE repo_id = $1) WHERE id = $1',
    [repoId]
  );

  // Invalidate repo cache since stars count changed
  await invalidateRepoCache(repoId);

  res.json({ starred: false });
});

/**
 * Check if repo is starred
 */
router.get('/:owner/:repo/starred', requireAuth, async (req, res) => {
  const { owner, repo } = req.params;

  const result = await query(
    `SELECT s.id FROM stars s
     JOIN repositories r ON s.repo_id = r.id
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2 AND s.user_id = $3`,
    [owner, repo, req.user.id]
  );

  res.json({ starred: result.rows.length > 0 });
});

export default router;
