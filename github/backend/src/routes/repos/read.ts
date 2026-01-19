/**
 * Repository Read Routes
 *
 * @description Handles endpoints for fetching individual repository details
 * including metadata, branches, and tags.
 *
 * @module routes/repos/read
 */
import { Router, Request, Response } from 'express';
import { query } from '../../db/index.js';
import * as gitService from '../../services/git.js';
import {
  getRepoFromCache,
  setRepoInCache,
  getBranchesFromCache,
  setBranchesInCache,
} from '../../shared/cache.js';
import { withCircuitBreaker } from '../../shared/circuitBreaker.js';
import { Repository, getRepoId, sendRepoNotFound } from './types.js';

const router = Router();

/**
 * GET /:owner/:repo - Get single repository details
 *
 * @description Retrieves complete repository metadata along with branches and tags.
 * Uses caching for repository data and branches to improve performance.
 * Private repositories are only accessible to their owners.
 *
 * @route GET /repos/:owner/:repo
 *
 * @param req.params.owner - The username of the repository owner
 * @param req.params.repo - The name of the repository
 *
 * @returns {Object} Repository with branches and tags
 * @returns {Repository} - Repository metadata including owner info
 * @returns {string[]} branches - Array of branch names
 * @returns {string[]} tags - Array of tag names
 *
 * @throws {404} Repository not found or not accessible
 *
 * @example
 * // GET /repos/octocat/hello-world
 * // Response: { id: 1, name: 'hello-world', branches: ['main'], tags: ['v1.0'] }
 */
router.get('/:owner/:repo', async (req: Request, res: Response): Promise<void> => {
  const { owner, repo } = req.params;

  const repoId = await getRepoId(owner, repo);
  if (!repoId) {
    sendRepoNotFound(res);
    return;
  }

  let repoData = await getRepoFromCache(repoId) as Repository | null;

  if (!repoData) {
    const result = await query(
      `SELECT r.*, u.username as owner_name, u.avatar_url as owner_avatar,
              u.display_name as owner_display_name
       FROM repositories r
       LEFT JOIN users u ON r.owner_id = u.id
       WHERE r.id = $1`,
      [repoId]
    );

    if (result.rows.length === 0) {
      sendRepoNotFound(res);
      return;
    }

    repoData = result.rows[0] as Repository;
    await setRepoInCache(repoId, repoData);
  }

  // Check access for private repos
  if (repoData.is_private && (!req.user || req.user.id !== repoData.owner_id)) {
    sendRepoNotFound(res);
    return;
  }

  // Get branches (with caching)
  let branches = await getBranchesFromCache(repoId);
  if (!branches) {
    branches = await withCircuitBreaker('git_branches', () => gitService.getBranches(owner, repo));
    await setBranchesInCache(repoId, branches);
  }

  // Get tags (no caching - changes less frequently)
  const tags = await withCircuitBreaker('git_tags', () => gitService.getTags(owner, repo));

  res.json({ ...repoData, branches, tags });
});

export default router;
