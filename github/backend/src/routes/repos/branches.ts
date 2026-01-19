/**
 * Repository Branch and Tag Routes
 *
 * @description Handles endpoints for retrieving branch and tag information
 * from Git repositories with caching support.
 *
 * @module routes/repos/branches
 */
import { Router, Request, Response } from 'express';
import * as gitService from '../../services/git.js';
import { getBranchesFromCache, setBranchesInCache } from '../../shared/cache.js';
import { withCircuitBreaker } from '../../shared/circuitBreaker.js';
import { getRepoId, sendRepoNotFound } from './types.js';

const router = Router();

/**
 * GET /:owner/:repo/branches - Get repository branches
 *
 * @description Retrieves all branches for a repository. Results are cached to improve
 * performance. Uses circuit breaker pattern for Git operations.
 *
 * @route GET /repos/:owner/:repo/branches
 *
 * @param req.params.owner - The username of the repository owner
 * @param req.params.repo - The name of the repository
 *
 * @returns {string[]} Array of branch names
 *
 * @throws {404} Repository not found
 *
 * @example
 * // GET /repos/octocat/hello-world/branches
 * // Response: ['main', 'develop', 'feature/new-feature']
 */
router.get('/:owner/:repo/branches', async (req: Request, res: Response): Promise<void> => {
  const { owner, repo } = req.params;

  const repoId = await getRepoId(owner, repo);
  if (!repoId) {
    sendRepoNotFound(res);
    return;
  }

  let branches = await getBranchesFromCache(repoId);

  if (!branches) {
    branches = await withCircuitBreaker('git_branches', () => gitService.getBranches(owner, repo));
    await setBranchesInCache(repoId, branches);
  }

  res.json(branches);
});

/**
 * GET /:owner/:repo/tags - Get repository tags
 *
 * @description Retrieves all tags for a repository. Tags are not cached as they
 * change less frequently than branches. Uses circuit breaker pattern for Git operations.
 *
 * @route GET /repos/:owner/:repo/tags
 *
 * @param req.params.owner - The username of the repository owner
 * @param req.params.repo - The name of the repository
 *
 * @returns {string[]} Array of tag names
 *
 * @example
 * // GET /repos/octocat/hello-world/tags
 * // Response: ['v1.0.0', 'v1.1.0', 'v2.0.0']
 */
router.get('/:owner/:repo/tags', async (req: Request, res: Response): Promise<void> => {
  const { owner, repo } = req.params;
  const tags = await withCircuitBreaker('git_tags', () => gitService.getTags(owner, repo));
  res.json(tags);
});

export default router;
