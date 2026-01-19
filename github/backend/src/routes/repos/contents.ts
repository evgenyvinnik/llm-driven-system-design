/**
 * Repository Contents Routes
 *
 * @description Handles endpoints for browsing repository file trees, retrieving file
 * content, and accessing commit history. All operations use caching and circuit
 * breaker patterns for reliability.
 *
 * @module routes/repos/contents
 */
import { Router, Request, Response } from 'express';
import * as gitService from '../../services/git.js';
import {
  getTreeFromCache,
  setTreeInCache,
  getFileFromCache,
  setFileInCache,
  getCommitsFromCache,
  setCommitsInCache,
} from '../../shared/cache.js';
import { withCircuitBreaker } from '../../shared/circuitBreaker.js';
import { TreeQueryParams, CommitsQueryParams, getRepoId, sendRepoNotFound } from './types.js';

const router = Router();

/**
 * GET /:owner/:repo/tree/:ref(*) - Get repository tree
 *
 * @description Retrieves the file tree structure at a specific Git reference (branch, tag, or commit).
 * Supports navigating to subdirectories via the path query parameter.
 * Results are cached for performance.
 *
 * @route GET /repos/:owner/:repo/tree/:ref
 *
 * @param req.params.owner - The username of the repository owner
 * @param req.params.repo - The name of the repository
 * @param req.params.ref - Git reference (branch name, tag, or commit SHA)
 * @param req.query.path - Optional subdirectory path within the tree (default: root)
 *
 * @returns {Object[]} Array of tree entries (files and directories)
 *
 * @throws {404} Repository not found
 *
 * @example
 * // GET /repos/octocat/hello-world/tree/main?path=src
 * // Response: [{ name: 'index.ts', type: 'blob', ... }, { name: 'lib', type: 'tree', ... }]
 */
router.get('/:owner/:repo/tree/:ref(*)', async (req: Request, res: Response): Promise<void> => {
  const { owner, repo, ref } = req.params;
  const { path: treePath = '' } = req.query as TreeQueryParams;

  const repoId = await getRepoId(owner, repo);
  if (!repoId) {
    sendRepoNotFound(res);
    return;
  }

  let tree = await getTreeFromCache(repoId, ref, treePath);

  if (!tree) {
    tree = await withCircuitBreaker('git_tree', () => gitService.getTree(owner, repo, ref, treePath));
    await setTreeInCache(repoId, ref, treePath, tree);
  }

  res.json(tree);
});

/**
 * GET /:owner/:repo/blob/:ref/:path(*) - Get file content
 *
 * @description Retrieves the content of a specific file at a given Git reference.
 * Results are cached for performance. Returns base64-encoded content for binary files.
 *
 * @route GET /repos/:owner/:repo/blob/:ref/:path
 *
 * @param req.params.owner - The username of the repository owner
 * @param req.params.repo - The name of the repository
 * @param req.params.ref - Git reference (branch name, tag, or commit SHA)
 * @param req.params.path - File path within the repository
 *
 * @returns {Object} File content object
 * @returns {string} path - The file path
 * @returns {string} content - The file content
 *
 * @throws {404} Repository not found or file not found
 *
 * @example
 * // GET /repos/octocat/hello-world/blob/main/README.md
 * // Response: { path: 'README.md', content: '# Hello World\n...' }
 */
router.get('/:owner/:repo/blob/:ref/:path(*)', async (req: Request, res: Response): Promise<void> => {
  const { owner, repo, ref, path: filePath } = req.params;

  const repoId = await getRepoId(owner, repo);
  if (!repoId) {
    sendRepoNotFound(res);
    return;
  }

  let content = await getFileFromCache(repoId, ref, filePath);

  if (content === null) {
    content = await withCircuitBreaker('git_file', () => gitService.getFileContent(owner, repo, ref, filePath));

    if (content === null) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    await setFileInCache(repoId, ref, filePath, content);
  }

  res.json({ path: filePath, content });
});

/**
 * GET /:owner/:repo/commits - Get commit history
 *
 * @description Retrieves paginated commit history for a repository, optionally filtered
 * by branch. Results are cached for performance.
 *
 * @route GET /repos/:owner/:repo/commits
 *
 * @param req.params.owner - The username of the repository owner
 * @param req.params.repo - The name of the repository
 * @param req.query.branch - Branch to get commits from (default: HEAD)
 * @param req.query.page - Page number for pagination (default: 1)
 * @param req.query.limit - Number of commits per page (default: 30)
 *
 * @returns {Object[]} Array of commit objects
 *
 * @throws {404} Repository not found
 *
 * @example
 * // GET /repos/octocat/hello-world/commits?branch=main&page=1&limit=10
 * // Response: [{ sha: 'abc123', message: 'Initial commit', ... }]
 */
router.get('/:owner/:repo/commits', async (req: Request, res: Response): Promise<void> => {
  const { owner, repo } = req.params;
  const { branch = 'HEAD', page = '1', limit = '30' } = req.query as CommitsQueryParams;

  const repoId = await getRepoId(owner, repo);
  if (!repoId) {
    sendRepoNotFound(res);
    return;
  }

  let commits = await getCommitsFromCache(repoId, branch, parseInt(page));

  if (!commits) {
    const skip = (parseInt(page) - 1) * parseInt(limit);
    commits = await withCircuitBreaker('git_commits', () =>
      gitService.getCommits(owner, repo, {
        branch,
        maxCount: parseInt(limit),
        skip,
      })
    );
    await setCommitsInCache(repoId, branch, parseInt(page), commits);
  }

  res.json(commits);
});

/**
 * GET /:owner/:repo/commit/:sha - Get single commit details
 *
 * @description Retrieves detailed information about a specific commit including
 * commit message, author, date, and file changes.
 *
 * @route GET /repos/:owner/:repo/commit/:sha
 *
 * @param req.params.owner - The username of the repository owner
 * @param req.params.repo - The name of the repository
 * @param req.params.sha - The commit SHA hash
 *
 * @returns {Object} Commit details including diff information
 *
 * @throws {404} Commit not found
 *
 * @example
 * // GET /repos/octocat/hello-world/commit/abc123
 * // Response: { sha: 'abc123', message: 'Fix bug', author: {...}, files: [...] }
 */
router.get('/:owner/:repo/commit/:sha', async (req: Request, res: Response): Promise<void> => {
  const { owner, repo, sha } = req.params;

  const commit = await withCircuitBreaker('git_commit', () => gitService.getCommit(owner, repo, sha));

  if (!commit) {
    res.status(404).json({ error: 'Commit not found' });
    return;
  }

  res.json(commit);
});

export default router;
