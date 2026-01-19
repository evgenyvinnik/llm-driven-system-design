/**
 * Repository Collaborator Routes
 *
 * @description Handles starring and unstarring repositories. These endpoints allow
 * authenticated users to bookmark their favorite repositories.
 *
 * @module routes/repos/collaborators
 */
import { Router, Request, Response } from 'express';
import { query } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { invalidateRepoCache } from '../../shared/cache.js';
import { getRepoId, sendRepoNotFound } from './types.js';

const router = Router();

/**
 * POST /:owner/:repo/star - Star a repository
 *
 * @description Adds the current user's star to a repository. If the user has already
 * starred the repository, this operation is idempotent. Updates the repository's
 * star count and invalidates the cache.
 *
 * @route POST /repos/:owner/:repo/star
 * @authentication Required
 *
 * @param req.params.owner - The username of the repository owner
 * @param req.params.repo - The name of the repository
 *
 * @returns {Object} Star status
 * @returns {boolean} starred - true indicating the repository is now starred
 *
 * @throws {401} Authentication required
 * @throws {404} Repository not found
 *
 * @example
 * // POST /repos/octocat/hello-world/star
 * // Response: { starred: true }
 */
router.post('/:owner/:repo/star', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { owner, repo } = req.params;

  const repoId = await getRepoId(owner, repo);
  if (!repoId) {
    sendRepoNotFound(res);
    return;
  }

  await query(
    `INSERT INTO stars (user_id, repo_id) VALUES ($1, $2)
     ON CONFLICT (user_id, repo_id) DO NOTHING`,
    [req.user!.id, repoId]
  );

  await query(
    'UPDATE repositories SET stars_count = (SELECT COUNT(*) FROM stars WHERE repo_id = $1) WHERE id = $1',
    [repoId]
  );

  await invalidateRepoCache(repoId);

  res.json({ starred: true });
});

/**
 * DELETE /:owner/:repo/star - Unstar a repository
 *
 * @description Removes the current user's star from a repository. Updates the
 * repository's star count and invalidates the cache.
 *
 * @route DELETE /repos/:owner/:repo/star
 * @authentication Required
 *
 * @param req.params.owner - The username of the repository owner
 * @param req.params.repo - The name of the repository
 *
 * @returns {Object} Star status
 * @returns {boolean} starred - false indicating the repository is no longer starred
 *
 * @throws {401} Authentication required
 * @throws {404} Repository not found
 *
 * @example
 * // DELETE /repos/octocat/hello-world/star
 * // Response: { starred: false }
 */
router.delete('/:owner/:repo/star', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { owner, repo } = req.params;

  const repoId = await getRepoId(owner, repo);
  if (!repoId) {
    sendRepoNotFound(res);
    return;
  }

  await query('DELETE FROM stars WHERE user_id = $1 AND repo_id = $2', [req.user!.id, repoId]);

  await query(
    'UPDATE repositories SET stars_count = (SELECT COUNT(*) FROM stars WHERE repo_id = $1) WHERE id = $1',
    [repoId]
  );

  await invalidateRepoCache(repoId);

  res.json({ starred: false });
});

/**
 * GET /:owner/:repo/starred - Check if repository is starred
 *
 * @description Checks whether the authenticated user has starred the specified repository.
 *
 * @route GET /repos/:owner/:repo/starred
 * @authentication Required
 *
 * @param req.params.owner - The username of the repository owner
 * @param req.params.repo - The name of the repository
 *
 * @returns {Object} Star status
 * @returns {boolean} starred - true if the user has starred this repository, false otherwise
 *
 * @throws {401} Authentication required
 *
 * @example
 * // GET /repos/octocat/hello-world/starred
 * // Response: { starred: true }
 */
router.get('/:owner/:repo/starred', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { owner, repo } = req.params;

  const result = await query(
    `SELECT s.id FROM stars s
     JOIN repositories r ON s.repo_id = r.id
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2 AND s.user_id = $3`,
    [owner, repo, req.user!.id]
  );

  res.json({ starred: result.rows.length > 0 });
});

export default router;
