import { Router, Request, Response } from 'express';
import { query } from '../db/index.js';
import * as gitService from '../services/git.js';
import { requireAuth } from '../middleware/auth.js';

// Import shared modules
import logger from '../shared/logger.js';
import { auditLog, AUDITED_ACTIONS } from '../shared/audit.js';
import { getPRDiffFromCache, setPRDiffInCache, invalidatePRDiffCache, invalidateRepoCaches } from '../shared/cache.js';
import { withCircuitBreaker } from '../shared/circuitBreaker.js';
import { getIdempotencyKey, withIdempotencyTransaction } from '../shared/idempotency.js';
import { prsCreated, prsMerged } from '../shared/metrics.js';

const router = Router();

interface PullRequest {
  id: number;
  repo_id: number;
  number: number;
  title: string;
  body: string | null;
  head_branch: string;
  head_sha: string;
  base_branch: string;
  base_sha: string;
  author_id: number;
  state: 'open' | 'closed' | 'merged';
  is_draft: boolean;
  additions: number;
  deletions: number;
  changed_files: number;
  merged_by: number | null;
  merged_at: Date | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  author_name?: string;
  author_avatar?: string;
  merged_by_name?: string;
}

interface ListPullsQuery {
  state?: string;
  page?: string;
  limit?: string;
}

interface CreatePRBody {
  title?: string;
  body?: string;
  headBranch?: string;
  baseBranch?: string;
  isDraft?: boolean;
}

interface UpdatePRBody {
  title?: string;
  body?: string;
  state?: string;
}

interface MergeBody {
  strategy?: 'merge' | 'squash' | 'rebase';
  message?: string;
}

interface ReviewBody {
  state?: 'approved' | 'changes_requested' | 'commented';
  body?: string;
}

interface CommentBody {
  body?: string;
}

/**
 * Get next PR/issue number for a repo
 */
async function getNextNumber(repoId: number): Promise<number> {
  const prResult = await query(
    'SELECT COALESCE(MAX(number), 0) as max_num FROM pull_requests WHERE repo_id = $1',
    [repoId]
  );
  const issueResult = await query(
    'SELECT COALESCE(MAX(number), 0) as max_num FROM issues WHERE repo_id = $1',
    [repoId]
  );

  return Math.max(parseInt(prResult.rows[0].max_num as string), parseInt(issueResult.rows[0].max_num as string)) + 1;
}

/**
 * List pull requests for a repo
 */
router.get('/:owner/:repo/pulls', async (req: Request, res: Response): Promise<void> => {
  const { owner, repo } = req.params;
  const { state = 'open', page = '1', limit = '20' } = req.query as ListPullsQuery;

  const repoResult = await query(
    `SELECT r.id FROM repositories r
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2`,
    [owner, repo]
  );

  if (repoResult.rows.length === 0) {
    res.status(404).json({ error: 'Repository not found' });
    return;
  }

  const repoId = repoResult.rows[0].id as number;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let stateFilter = '';
  const params: unknown[] = [repoId];

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
    total: parseInt(countResult.rows[0].count as string),
    page: parseInt(page),
    limit: parseInt(limit),
  });
});

/**
 * Get single pull request
 */
router.get('/:owner/:repo/pulls/:number', async (req: Request, res: Response): Promise<void> => {
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
    res.status(404).json({ error: 'Pull request not found' });
    return;
  }

  const pr = result.rows[0] as PullRequest;

  // Get commits with circuit breaker
  const commits = await withCircuitBreaker('git_commits_between', () =>
    gitService.getCommitsBetween(owner, repo, pr.base_branch, pr.head_branch)
  );

  // Get diff summary with circuit breaker
  const diff = await withCircuitBreaker('git_diff', () =>
    gitService.getDiff(owner, repo, pr.base_branch, pr.head_branch)
  );

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
 * Get PR diff (with caching)
 */
router.get('/:owner/:repo/pulls/:number/diff', async (req: Request, res: Response): Promise<void> => {
  const { owner, repo, number } = req.params;

  const result = await query(
    `SELECT p.id, p.head_branch, p.base_branch
     FROM pull_requests p
     JOIN repositories r ON p.repo_id = r.id
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2 AND p.number = $3`,
    [owner, repo, parseInt(number)]
  );

  if (result.rows.length === 0) {
    res.status(404).json({ error: 'Pull request not found' });
    return;
  }

  const pr = result.rows[0] as { id: number; head_branch: string; base_branch: string };

  // Try cache first
  let diff = await getPRDiffFromCache(pr.id);

  if (!diff) {
    // Cache miss - fetch with circuit breaker
    diff = await withCircuitBreaker('git_diff', () =>
      gitService.getDiff(owner, repo, pr.base_branch, pr.head_branch)
    );

    // Cache the result
    await setPRDiffInCache(pr.id, diff);
  }

  res.json(diff);
});

/**
 * Create pull request (with idempotency)
 */
router.post('/:owner/:repo/pulls', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { owner, repo } = req.params;
  const { title, body, headBranch, baseBranch, isDraft } = req.body as CreatePRBody;
  const idempotencyKey = getIdempotencyKey(req);

  if (!title || !headBranch || !baseBranch) {
    res.status(400).json({ error: 'Title, head branch, and base branch required' });
    return;
  }

  const repoResult = await query(
    `SELECT r.id, r.default_branch FROM repositories r
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2`,
    [owner, repo]
  );

  if (repoResult.rows.length === 0) {
    res.status(404).json({ error: 'Repository not found' });
    return;
  }

  const repoId = repoResult.rows[0].id as number;

  // Verify branches exist with circuit breaker
  const headExists = await withCircuitBreaker('git_branch_exists', () =>
    gitService.branchExists(owner, repo, headBranch)
  );
  const baseExists = await withCircuitBreaker('git_branch_exists', () =>
    gitService.branchExists(owner, repo, baseBranch)
  );

  if (!headExists) {
    res.status(400).json({ error: 'Head branch does not exist' });
    return;
  }
  if (!baseExists) {
    res.status(400).json({ error: 'Base branch does not exist' });
    return;
  }

  try {
    // Use idempotency transaction
    const { cached, response } = await withIdempotencyTransaction(
      idempotencyKey || '',
      'pr_create',
      async (tx) => {
        // Get SHAs with circuit breaker
        const headSha = await withCircuitBreaker('git_head_sha', () =>
          gitService.getHeadSha(owner, repo, headBranch)
        );
        const baseSha = await withCircuitBreaker('git_head_sha', () =>
          gitService.getHeadSha(owner, repo, baseBranch)
        );

        // Get diff stats with circuit breaker
        const diff = await withCircuitBreaker('git_diff', () =>
          gitService.getDiff(owner, repo, baseBranch, headBranch)
        );

        // Get next number (use transaction client)
        const prMax = await tx.query(
          'SELECT COALESCE(MAX(number), 0) as max_num FROM pull_requests WHERE repo_id = $1',
          [repoId]
        );
        const issueMax = await tx.query(
          'SELECT COALESCE(MAX(number), 0) as max_num FROM issues WHERE repo_id = $1',
          [repoId]
        );
        const prNumber = Math.max(
          parseInt(prMax.rows[0].max_num as string),
          parseInt(issueMax.rows[0].max_num as string)
        ) + 1;

        // Insert PR
        const insertResult = await tx.query(
          `INSERT INTO pull_requests
           (repo_id, number, title, body, head_branch, head_sha, base_branch, base_sha,
            author_id, additions, deletions, changed_files, is_draft)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           RETURNING *`,
          [
            repoId,
            prNumber,
            title,
            body || null,
            headBranch,
            headSha,
            baseBranch,
            baseSha,
            req.user!.id,
            diff.stats.additions,
            diff.stats.deletions,
            diff.stats.files.length,
            isDraft || false,
          ]
        );

        const pr = insertResult.rows[0] as PullRequest;

        return { resourceId: pr.id, response: pr };
      }
    );

    if (cached) {
      // Return cached response for duplicate request
      prsCreated.inc({ status: 'duplicate' });
      req.log?.info({ idempotencyKey }, 'PR creation request deduplicated');
      res.status(200).json(response);
      return;
    }

    // Audit log
    await auditLog(
      AUDITED_ACTIONS.PR_CREATE,
      'pull_request',
      response.id,
      { title, headBranch, baseBranch, isDraft },
      req
    );

    prsCreated.inc({ status: 'success' });
    res.status(201).json(response);
  } catch (err) {
    req.log?.error({ err }, 'Create PR error');
    prsCreated.inc({ status: 'error' });
    res.status(500).json({ error: 'Failed to create pull request' });
  }
});

/**
 * Update pull request
 */
router.patch('/:owner/:repo/pulls/:number', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { owner, repo, number } = req.params;
  const { title, body, state } = req.body as UpdatePRBody;

  const prResult = await query(
    `SELECT p.* FROM pull_requests p
     JOIN repositories r ON p.repo_id = r.id
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2 AND p.number = $3`,
    [owner, repo, parseInt(number)]
  );

  if (prResult.rows.length === 0) {
    res.status(404).json({ error: 'Pull request not found' });
    return;
  }

  const pr = prResult.rows[0] as PullRequest;

  // Only author can update
  if (pr.author_id !== req.user!.id) {
    res.status(403).json({ error: 'Not authorized' });
    return;
  }

  const updates: string[] = [];
  const params: unknown[] = [];

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

      // Audit log for close
      await auditLog(AUDITED_ACTIONS.PR_CLOSE, 'pull_request', pr.id, { number }, req);
    }
  }

  if (updates.length === 0) {
    res.json(pr);
    return;
  }

  params.push(new Date());
  updates.push(`updated_at = $${params.length}`);

  params.push(pr.id);

  const result = await query(
    `UPDATE pull_requests SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );

  // Invalidate diff cache if PR was updated
  await invalidatePRDiffCache(pr.id);

  res.json(result.rows[0]);
});

/**
 * Merge pull request
 */
router.post('/:owner/:repo/pulls/:number/merge', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { owner, repo, number } = req.params;
  const { strategy = 'merge', message } = req.body as MergeBody;

  const prResult = await query(
    `SELECT p.*, r.id as repo_id FROM pull_requests p
     JOIN repositories r ON p.repo_id = r.id
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2 AND p.number = $3`,
    [owner, repo, parseInt(number)]
  );

  if (prResult.rows.length === 0) {
    res.status(404).json({ error: 'Pull request not found' });
    return;
  }

  const pr = prResult.rows[0] as PullRequest;

  if (pr.state !== 'open') {
    res.status(400).json({ error: 'Pull request is not open' });
    return;
  }

  try {
    // Perform merge with circuit breaker
    const mergeResult = await withCircuitBreaker('git_merge', () =>
      gitService.mergeBranches(
        owner,
        repo,
        pr.base_branch,
        pr.head_branch,
        strategy,
        message || `Merge pull request #${number}`
      )
    );

    if (!mergeResult.success) {
      res.status(400).json({ error: mergeResult.error || 'Merge failed' });
      return;
    }

    // Update PR
    await query(
      `UPDATE pull_requests
       SET state = 'merged', merged_by = $1, merged_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [req.user!.id, pr.id]
    );

    // Invalidate caches
    await invalidatePRDiffCache(pr.id);
    await invalidateRepoCaches(pr.repo_id);

    // Audit log
    await auditLog(
      AUDITED_ACTIONS.PR_MERGE,
      'pull_request',
      pr.id,
      { number, strategy, mergeCommit: mergeResult.sha },
      req
    );

    // Update metrics
    prsMerged.inc({ strategy });

    res.json({ merged: true, sha: mergeResult.sha });
  } catch (err) {
    req.log?.error({ err }, 'Merge PR error');
    res.status(500).json({ error: 'Merge failed' });
  }
});

/**
 * Add review
 */
router.post('/:owner/:repo/pulls/:number/reviews', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { owner, repo, number } = req.params;
  const { state, body } = req.body as ReviewBody;

  if (!state || !['approved', 'changes_requested', 'commented'].includes(state)) {
    res.status(400).json({ error: 'Invalid review state' });
    return;
  }

  const prResult = await query(
    `SELECT p.* FROM pull_requests p
     JOIN repositories r ON p.repo_id = r.id
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2 AND p.number = $3`,
    [owner, repo, parseInt(number)]
  );

  if (prResult.rows.length === 0) {
    res.status(404).json({ error: 'Pull request not found' });
    return;
  }

  const pr = prResult.rows[0] as PullRequest;

  const result = await query(
    `INSERT INTO reviews (pr_id, reviewer_id, state, body, commit_sha)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [pr.id, req.user!.id, state, body || null, pr.head_sha]
  );

  res.status(201).json(result.rows[0]);
});

/**
 * Get PR comments
 */
router.get('/:owner/:repo/pulls/:number/comments', async (req: Request, res: Response): Promise<void> => {
  const { owner, repo, number } = req.params;

  const prResult = await query(
    `SELECT p.id FROM pull_requests p
     JOIN repositories r ON p.repo_id = r.id
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2 AND p.number = $3`,
    [owner, repo, parseInt(number)]
  );

  if (prResult.rows.length === 0) {
    res.status(404).json({ error: 'Pull request not found' });
    return;
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
router.post('/:owner/:repo/pulls/:number/comments', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { owner, repo, number } = req.params;
  const { body } = req.body as CommentBody;

  if (!body) {
    res.status(400).json({ error: 'Comment body required' });
    return;
  }

  const prResult = await query(
    `SELECT p.id FROM pull_requests p
     JOIN repositories r ON p.repo_id = r.id
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2 AND p.number = $3`,
    [owner, repo, parseInt(number)]
  );

  if (prResult.rows.length === 0) {
    res.status(404).json({ error: 'Pull request not found' });
    return;
  }

  const result = await query(
    `INSERT INTO comments (pr_id, user_id, body)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [prResult.rows[0].id, req.user!.id, body]
  );

  res.status(201).json(result.rows[0]);
});

export default router;
