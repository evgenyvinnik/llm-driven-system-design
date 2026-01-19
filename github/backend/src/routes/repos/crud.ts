/**
 * Repository CRUD Routes
 *
 * @description Handles Create, Update, and Delete operations for repositories.
 * All operations require authentication and appropriate authorization.
 *
 * @module routes/repos/crud
 */
import { Router, Request, Response } from 'express';
import { query } from '../../db/index.js';
import * as gitService from '../../services/git.js';
import * as searchService from '../../services/search.js';
import { requireAuth } from '../../middleware/auth.js';
import { auditLog, AUDITED_ACTIONS } from '../../shared/audit.js';
import { invalidateRepoCache, invalidateRepoCaches } from '../../shared/cache.js';
import {
  Repository,
  CreateRepoBody,
  UpdateRepoBody,
  getRepoByOwnerAndName,
  sendRepoNotFound,
  isRepoOwner,
} from './types.js';

const router = Router();

/**
 * POST / - Create a new repository
 *
 * @description Creates a new Git repository for the authenticated user. Initializes
 * a bare Git repository on disk, creates the database record, and optionally adds
 * an initial README file. Also creates default labels for the repository.
 *
 * @route POST /repos
 * @authentication Required
 *
 * @param req.body.name - Repository name (alphanumeric, underscores, and hyphens only)
 * @param req.body.description - Optional repository description
 * @param req.body.isPrivate - Whether the repository should be private (default: false)
 * @param req.body.initWithReadme - Whether to create an initial README file (default: false)
 *
 * @returns {Repository} The created repository object
 *
 * @throws {400} Invalid repository name format
 * @throws {401} Authentication required
 * @throws {409} Repository with same name already exists for this user
 * @throws {500} Failed to create repository
 *
 * @example
 * // POST /repos
 * // Body: { name: 'my-project', description: 'A new project', isPrivate: false }
 * // Response: { id: 1, name: 'my-project', ... }
 */
router.post('/', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { name, description, isPrivate, initWithReadme } = req.body as CreateRepoBody;

  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    res.status(400).json({ error: 'Invalid repository name' });
    return;
  }

  try {
    const existing = await query(
      'SELECT id FROM repositories WHERE owner_id = $1 AND name = $2',
      [req.user!.id, name]
    );

    if (existing.rows.length > 0) {
      res.status(409).json({ error: 'Repository already exists' });
      return;
    }

    const storagePath = await gitService.initRepository(req.user!.username, name);

    const result = await query(
      `INSERT INTO repositories (owner_id, name, description, is_private, storage_path)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.user!.id, name, description || null, isPrivate || false, storagePath]
    );

    const newRepo = result.rows[0] as Repository;

    if (initWithReadme) {
      await gitService.initWithReadme(req.user!.username, name, description || '');
    }

    const defaultLabels = [
      { name: 'bug', color: '#d73a4a', description: 'Something is not working' },
      { name: 'enhancement', color: '#a2eeef', description: 'New feature or request' },
      { name: 'documentation', color: '#0075ca', description: 'Improvements to documentation' },
      { name: 'good first issue', color: '#7057ff', description: 'Good for newcomers' },
    ];

    for (const label of defaultLabels) {
      await query(
        'INSERT INTO labels (repo_id, name, color, description) VALUES ($1, $2, $3, $4)',
        [newRepo.id, label.name, label.color, label.description]
      );
    }

    await auditLog(AUDITED_ACTIONS.REPO_CREATE, 'repository', newRepo.id, { name, isPrivate, initWithReadme }, req);

    res.status(201).json(newRepo);
  } catch (err) {
    req.log?.error({ err }, 'Create repo error');
    res.status(500).json({ error: 'Failed to create repository' });
  }
});

/**
 * PATCH /:owner/:repo - Update repository settings
 *
 * @description Updates repository metadata including description, visibility, and default branch.
 * Only the repository owner can update settings. Changes are audited and cached data is invalidated.
 *
 * @route PATCH /repos/:owner/:repo
 * @authentication Required
 *
 * @param req.params.owner - The username of the repository owner
 * @param req.params.repo - The name of the repository
 * @param req.body.description - New repository description
 * @param req.body.isPrivate - New visibility setting
 * @param req.body.defaultBranch - New default branch name
 *
 * @returns {Repository} The updated repository object
 *
 * @throws {401} Authentication required
 * @throws {403} User is not authorized to modify this repository
 * @throws {404} Repository not found
 *
 * @example
 * // PATCH /repos/octocat/hello-world
 * // Body: { description: 'Updated description', isPrivate: true }
 * // Response: { id: 1, description: 'Updated description', is_private: true, ... }
 */
router.patch('/:owner/:repo', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { owner, repo } = req.params;
  const { description, isPrivate, defaultBranch } = req.body as UpdateRepoBody;

  const repoData = await getRepoByOwnerAndName(owner, repo);
  if (!repoData) {
    sendRepoNotFound(res);
    return;
  }

  if (!isRepoOwner(repoData, req.user!.id)) {
    res.status(403).json({ error: 'Not authorized' });
    return;
  }

  const updates: string[] = [];
  const params: unknown[] = [];
  const changes: Record<string, unknown> = {};

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
    res.json(repoData);
    return;
  }

  params.push(new Date());
  updates.push(`updated_at = $${params.length}`);
  params.push(repoData.id);

  const result = await query(
    `UPDATE repositories SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );

  await invalidateRepoCache(repoData.id);

  const action = isPrivate !== undefined ? AUDITED_ACTIONS.REPO_VISIBILITY_CHANGE : AUDITED_ACTIONS.REPO_SETTINGS_CHANGE;
  await auditLog(action, 'repository', repoData.id, changes, req);

  res.json(result.rows[0]);
});

/**
 * DELETE /:owner/:repo - Delete a repository
 *
 * @description Permanently deletes a repository including all Git data, search index entries,
 * and database records. This action cannot be undone. Only the repository owner can delete.
 *
 * @route DELETE /repos/:owner/:repo
 * @authentication Required
 *
 * @param req.params.owner - The username of the repository owner
 * @param req.params.repo - The name of the repository
 *
 * @returns {Object} Success confirmation
 * @returns {boolean} success - true if deletion was successful
 *
 * @throws {401} Authentication required
 * @throws {403} User is not authorized to delete this repository
 * @throws {404} Repository not found
 * @throws {500} Failed to delete repository
 *
 * @example
 * // DELETE /repos/octocat/hello-world
 * // Response: { success: true }
 */
router.delete('/:owner/:repo', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { owner, repo } = req.params;

  const repoData = await getRepoByOwnerAndName(owner, repo);
  if (!repoData) {
    sendRepoNotFound(res);
    return;
  }

  if (!isRepoOwner(repoData, req.user!.id)) {
    res.status(403).json({ error: 'Not authorized' });
    return;
  }

  try {
    await gitService.deleteRepository(owner, repo);
    await searchService.removeRepositoryIndex(repoData.id);
    await query('DELETE FROM repositories WHERE id = $1', [repoData.id]);
    await invalidateRepoCaches(repoData.id);
    await auditLog(AUDITED_ACTIONS.REPO_DELETE, 'repository', repoData.id, { name: repo, owner }, req);

    res.json({ success: true });
  } catch (err) {
    req.log?.error({ err }, 'Delete repo error');
    res.status(500).json({ error: 'Failed to delete repository' });
  }
});

export default router;
