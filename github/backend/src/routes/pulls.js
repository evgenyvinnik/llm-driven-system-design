import { Router } from 'express';
import { query } from '../db/index.js';
import * as gitService from '../services/git.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

/**
 * Get next PR/issue number for a repo
 */
async function getNextNumber(repoId) {
  const prResult = await query(
    'SELECT COALESCE(MAX(number), 0) as max_num FROM pull_requests WHERE repo_id = $1',
    [repoId]
  );
  const issueResult = await query(
    'SELECT COALESCE(MAX(number), 0) as max_num FROM issues WHERE repo_id = $1',
    [repoId]
  );

  return Math.max(parseInt(prResult.rows[0].max_num), parseInt(issueResult.rows[0].max_num)) + 1;
}

/**
 * List pull requests for a repo
 */
router.get('/:owner/:repo/pulls', async (req, res) => {
  const { owner, repo } = req.params;
  const { state = 'open', page = 1, limit = 20 } = req.query;

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
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let stateFilter = '';
  const params = [repoId];

  if (state === 'open') {
    stateFilter = 'AND p.state = $2';
    params.push('open');
  } else if (state === 'closed') {
    stateFilter = 'AND p.state IN ($2, $3)';
    params.push('closed', 'merged');
  }

  const result = await query(
    `SELECT p.*, u.username as author_name, u.avatar_url as author_avatar
     FROM pull_requests p
     JOIN users u ON p.author_id = u.id
     WHERE p.repo_id = $1 ${stateFilter}
     ORDER BY p.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, parseInt(limit), offset]
  );

  const countResult = await query(
    `SELECT COUNT(*) FROM pull_requests p WHERE p.repo_id = $1 ${stateFilter}`,
    params
  );

  res.json({
    pulls: result.rows,
    total: parseInt(countResult.rows[0].count),
    page: parseInt(page),
    limit: parseInt(limit),
  });
});

/**
 * Get single pull request
 */
router.get('/:owner/:repo/pulls/:number', async (req, res) => {
  const { owner, repo, number } = req.params;

  const result = await query(
    `SELECT p.*,
            author.username as author_name,
            author.avatar_url as author_avatar,
            merger.username as merged_by_name
     FROM pull_requests p
     JOIN repositories r ON p.repo_id = r.id
     JOIN users owner_user ON r.owner_id = owner_user.id
     JOIN users author ON p.author_id = author.id
     LEFT JOIN users merger ON p.merged_by = merger.id
     WHERE owner_user.username = $1 AND r.name = $2 AND p.number = $3`,
    [owner, repo, parseInt(number)]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Pull request not found' });
  }

  const pr = result.rows[0];

  // Get commits
  const commits = await gitService.getCommitsBetween(owner, repo, pr.base_branch, pr.head_branch);

  // Get diff summary
  const diff = await gitService.getDiff(owner, repo, pr.base_branch, pr.head_branch);

  // Get reviews
  const reviews = await query(
    `SELECT rv.*, u.username as reviewer_name, u.avatar_url as reviewer_avatar
     FROM reviews rv
     JOIN users u ON rv.reviewer_id = u.id
     WHERE rv.pr_id = $1
     ORDER BY rv.created_at DESC`,
    [pr.id]
  );

  // Get labels
  const labels = await query(
    `SELECT l.* FROM labels l
     JOIN pr_labels pl ON l.id = pl.label_id
     WHERE pl.pr_id = $1`,
    [pr.id]
  );

  res.json({
    ...pr,
    commits,
    diff: diff.stats,
    reviews: reviews.rows,
    labels: labels.rows,
  });
});

/**
 * Get PR diff
 */
router.get('/:owner/:repo/pulls/:number/diff', async (req, res) => {
  const { owner, repo, number } = req.params;

  const result = await query(
    `SELECT p.head_branch, p.base_branch
     FROM pull_requests p
     JOIN repositories r ON p.repo_id = r.id
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2 AND p.number = $3`,
    [owner, repo, parseInt(number)]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Pull request not found' });
  }

  const pr = result.rows[0];
  const diff = await gitService.getDiff(owner, repo, pr.base_branch, pr.head_branch);

  res.json(diff);
});

/**
 * Create pull request
 */
router.post('/:owner/:repo/pulls', requireAuth, async (req, res) => {
  const { owner, repo } = req.params;
  const { title, body, headBranch, baseBranch, isDraft } = req.body;

  if (!title || !headBranch || !baseBranch) {
    return res.status(400).json({ error: 'Title, head branch, and base branch required' });
  }

  const repoResult = await query(
    `SELECT r.id, r.default_branch FROM repositories r
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2`,
    [owner, repo]
  );

  if (repoResult.rows.length === 0) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  const repoId = repoResult.rows[0].id;

  // Verify branches exist
  const headExists = await gitService.branchExists(owner, repo, headBranch);
  const baseExists = await gitService.branchExists(owner, repo, baseBranch);

  if (!headExists) {
    return res.status(400).json({ error: 'Head branch does not exist' });
  }
  if (!baseExists) {
    return res.status(400).json({ error: 'Base branch does not exist' });
  }

  // Get SHAs
  const headSha = await gitService.getHeadSha(owner, repo, headBranch);
  const baseSha = await gitService.getHeadSha(owner, repo, baseBranch);

  // Get diff stats
  const diff = await gitService.getDiff(owner, repo, baseBranch, headBranch);

  // Get next number
  const number = await getNextNumber(repoId);

  const result = await query(
    `INSERT INTO pull_requests
     (repo_id, number, title, body, head_branch, head_sha, base_branch, base_sha,
      author_id, additions, deletions, changed_files, is_draft)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      repoId,
      number,
      title,
      body || null,
      headBranch,
      headSha,
      baseBranch,
      baseSha,
      req.user.id,
      diff.stats.additions,
      diff.stats.deletions,
      diff.stats.files.length,
      isDraft || false,
    ]
  );

  res.status(201).json(result.rows[0]);
});

/**
 * Update pull request
 */
router.patch('/:owner/:repo/pulls/:number', requireAuth, async (req, res) => {
  const { owner, repo, number } = req.params;
  const { title, body, state } = req.body;

  const prResult = await query(
    `SELECT p.* FROM pull_requests p
     JOIN repositories r ON p.repo_id = r.id
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2 AND p.number = $3`,
    [owner, repo, parseInt(number)]
  );

  if (prResult.rows.length === 0) {
    return res.status(404).json({ error: 'Pull request not found' });
  }

  const pr = prResult.rows[0];

  // Only author can update
  if (pr.author_id !== req.user.id) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  const updates = [];
  const params = [];

  if (title !== undefined) {
    params.push(title);
    updates.push(`title = $${params.length}`);
  }
  if (body !== undefined) {
    params.push(body);
    updates.push(`body = $${params.length}`);
  }
  if (state !== undefined) {
    params.push(state);
    updates.push(`state = $${params.length}`);
    if (state === 'closed') {
      params.push(new Date());
      updates.push(`closed_at = $${params.length}`);
    }
  }

  if (updates.length === 0) {
    return res.json(pr);
  }

  params.push(new Date());
  updates.push(`updated_at = $${params.length}`);

  params.push(pr.id);

  const result = await query(
    `UPDATE pull_requests SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );

  res.json(result.rows[0]);
});

/**
 * Merge pull request
 */
router.post('/:owner/:repo/pulls/:number/merge', requireAuth, async (req, res) => {
  const { owner, repo, number } = req.params;
  const { strategy = 'merge', message } = req.body;

  const prResult = await query(
    `SELECT p.*, r.id as repo_id FROM pull_requests p
     JOIN repositories r ON p.repo_id = r.id
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2 AND p.number = $3`,
    [owner, repo, parseInt(number)]
  );

  if (prResult.rows.length === 0) {
    return res.status(404).json({ error: 'Pull request not found' });
  }

  const pr = prResult.rows[0];

  if (pr.state !== 'open') {
    return res.status(400).json({ error: 'Pull request is not open' });
  }

  // Perform merge
  const mergeResult = await gitService.mergeBranches(
    owner,
    repo,
    pr.base_branch,
    pr.head_branch,
    strategy,
    message || `Merge pull request #${number}`
  );

  if (!mergeResult.success) {
    return res.status(400).json({ error: mergeResult.error || 'Merge failed' });
  }

  // Update PR
  await query(
    `UPDATE pull_requests
     SET state = 'merged', merged_by = $1, merged_at = NOW(), updated_at = NOW()
     WHERE id = $2`,
    [req.user.id, pr.id]
  );

  res.json({ merged: true, sha: mergeResult.sha });
});

/**
 * Add review
 */
router.post('/:owner/:repo/pulls/:number/reviews', requireAuth, async (req, res) => {
  const { owner, repo, number } = req.params;
  const { state, body } = req.body;

  if (!state || !['approved', 'changes_requested', 'commented'].includes(state)) {
    return res.status(400).json({ error: 'Invalid review state' });
  }

  const prResult = await query(
    `SELECT p.* FROM pull_requests p
     JOIN repositories r ON p.repo_id = r.id
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2 AND p.number = $3`,
    [owner, repo, parseInt(number)]
  );

  if (prResult.rows.length === 0) {
    return res.status(404).json({ error: 'Pull request not found' });
  }

  const pr = prResult.rows[0];

  const result = await query(
    `INSERT INTO reviews (pr_id, reviewer_id, state, body, commit_sha)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [pr.id, req.user.id, state, body || null, pr.head_sha]
  );

  res.status(201).json(result.rows[0]);
});

/**
 * Get PR comments
 */
router.get('/:owner/:repo/pulls/:number/comments', async (req, res) => {
  const { owner, repo, number } = req.params;

  const prResult = await query(
    `SELECT p.id FROM pull_requests p
     JOIN repositories r ON p.repo_id = r.id
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2 AND p.number = $3`,
    [owner, repo, parseInt(number)]
  );

  if (prResult.rows.length === 0) {
    return res.status(404).json({ error: 'Pull request not found' });
  }

  const result = await query(
    `SELECT c.*, u.username as user_name, u.avatar_url as user_avatar
     FROM comments c
     JOIN users u ON c.user_id = u.id
     WHERE c.pr_id = $1
     ORDER BY c.created_at ASC`,
    [prResult.rows[0].id]
  );

  res.json(result.rows);
});

/**
 * Add PR comment
 */
router.post('/:owner/:repo/pulls/:number/comments', requireAuth, async (req, res) => {
  const { owner, repo, number } = req.params;
  const { body } = req.body;

  if (!body) {
    return res.status(400).json({ error: 'Comment body required' });
  }

  const prResult = await query(
    `SELECT p.id FROM pull_requests p
     JOIN repositories r ON p.repo_id = r.id
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2 AND p.number = $3`,
    [owner, repo, parseInt(number)]
  );

  if (prResult.rows.length === 0) {
    return res.status(404).json({ error: 'Pull request not found' });
  }

  const result = await query(
    `INSERT INTO comments (pr_id, user_id, body)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [prResult.rows[0].id, req.user.id, body]
  );

  res.status(201).json(result.rows[0]);
});

export default router;
