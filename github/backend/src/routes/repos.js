import { Router } from 'express';
import { query } from '../db/index.js';
import * as gitService from '../services/git.js';
import * as searchService from '../services/search.js';
import { requireAuth } from '../middleware/auth.js';

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
 * Get single repository
 */
router.get('/:owner/:repo', async (req, res) => {
  const { owner, repo } = req.params;

  const result = await query(
    `SELECT r.*, u.username as owner_name, u.avatar_url as owner_avatar,
            u.display_name as owner_display_name
     FROM repositories r
     LEFT JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2`,
    [owner, repo]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  const repoData = result.rows[0];

  // Check access
  if (repoData.is_private && (!req.user || req.user.id !== repoData.owner_id)) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  // Get branches
  const branches = await gitService.getBranches(owner, repo);

  // Get tags
  const tags = await gitService.getTags(owner, repo);

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

    res.status(201).json(repo);
  } catch (err) {
    console.error('Create repo error:', err);
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

  if (description !== undefined) {
    params.push(description);
    updates.push(`description = $${params.length}`);
  }
  if (isPrivate !== undefined) {
    params.push(isPrivate);
    updates.push(`is_private = $${params.length}`);
  }
  if (defaultBranch !== undefined) {
    params.push(defaultBranch);
    updates.push(`default_branch = $${params.length}`);
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
    // Delete git repository
    await gitService.deleteRepository(owner, repo);

    // Remove from search index
    await searchService.removeRepositoryIndex(repoResult.rows[0].id);

    // Delete from database (cascade will handle related records)
    await query('DELETE FROM repositories WHERE id = $1', [repoResult.rows[0].id]);

    res.json({ success: true });
  } catch (err) {
    console.error('Delete repo error:', err);
    res.status(500).json({ error: 'Failed to delete repository' });
  }
});

/**
 * Get repository tree
 */
router.get('/:owner/:repo/tree/:ref(*)', async (req, res) => {
  const { owner, repo, ref } = req.params;
  const { path: treePath = '' } = req.query;

  const tree = await gitService.getTree(owner, repo, ref, treePath);
  res.json(tree);
});

/**
 * Get file content
 */
router.get('/:owner/:repo/blob/:ref/:path(*)', async (req, res) => {
  const { owner, repo, ref, path: filePath } = req.params;

  const content = await gitService.getFileContent(owner, repo, ref, filePath);

  if (content === null) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.json({ path: filePath, content });
});

/**
 * Get commits
 */
router.get('/:owner/:repo/commits', async (req, res) => {
  const { owner, repo } = req.params;
  const { branch = 'HEAD', page = 1, limit = 30 } = req.query;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const commits = await gitService.getCommits(owner, repo, {
    branch,
    maxCount: parseInt(limit),
    skip,
  });

  res.json(commits);
});

/**
 * Get single commit
 */
router.get('/:owner/:repo/commit/:sha', async (req, res) => {
  const { owner, repo, sha } = req.params;

  const commit = await gitService.getCommit(owner, repo, sha);

  if (!commit) {
    return res.status(404).json({ error: 'Commit not found' });
  }

  res.json(commit);
});

/**
 * Get branches
 */
router.get('/:owner/:repo/branches', async (req, res) => {
  const { owner, repo } = req.params;
  const branches = await gitService.getBranches(owner, repo);
  res.json(branches);
});

/**
 * Get tags
 */
router.get('/:owner/:repo/tags', async (req, res) => {
  const { owner, repo } = req.params;
  const tags = await gitService.getTags(owner, repo);
  res.json(tags);
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
