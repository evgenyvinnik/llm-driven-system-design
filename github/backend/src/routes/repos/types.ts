import { Response } from 'express';
import { query } from '../../db/index.js';

/**
 * Repository entity representing a Git repository.
 * Contains all metadata about a repository including ownership, visibility, and statistics.
 */
export interface Repository {
  id: number;
  owner_id: number;
  name: string;
  description: string | null;
  is_private: boolean;
  default_branch: string;
  storage_path: string;
  stars_count: number;
  forks_count: number;
  created_at: Date;
  updated_at: Date;
  owner_name?: string;
  owner_avatar?: string;
  owner_display_name?: string;
}

/**
 * Query parameters for listing repositories.
 * Supports pagination, filtering by owner, and sorting options.
 */
export interface ListQueryParams {
  owner?: string;
  page?: string;
  limit?: string;
  sort?: string;
}

/**
 * Query parameters for tree navigation.
 * Used when browsing the file structure of a repository.
 */
export interface TreeQueryParams {
  path?: string;
}

/**
 * Query parameters for commits listing.
 * Supports pagination and filtering by branch.
 */
export interface CommitsQueryParams {
  branch?: string;
  page?: string;
  limit?: string;
}

/**
 * Request body for push webhook.
 * Contains information about the pushed branch and commits.
 */
export interface PushBody {
  branch?: string;
  commits?: unknown[];
}

/**
 * Request body for creating a repository.
 * Contains all options available when creating a new repository.
 */
export interface CreateRepoBody {
  name?: string;
  description?: string;
  isPrivate?: boolean;
  initWithReadme?: boolean;
}

/**
 * Request body for updating a repository.
 * All fields are optional; only provided fields will be updated.
 */
export interface UpdateRepoBody {
  description?: string;
  isPrivate?: boolean;
  defaultBranch?: string;
}

/**
 * Retrieves the repository ID from the database by owner username and repository name.
 *
 * @description Looks up a repository by joining the repositories and users tables
 * to find a match based on the owner's username and repository name.
 *
 * @param owner - The username of the repository owner
 * @param repo - The name of the repository
 * @returns The repository ID if found, or null if the repository does not exist
 *
 * @example
 * const repoId = await getRepoId('octocat', 'hello-world');
 * if (repoId) {
 *   console.log(`Repository ID: ${repoId}`);
 * }
 */
export async function getRepoId(owner: string, repo: string): Promise<number | null> {
  const result = await query(
    `SELECT r.id FROM repositories r
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2`,
    [owner, repo]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0].id as number;
}

/**
 * Retrieves complete repository data from the database by owner username and repository name.
 *
 * @description Performs a database lookup to fetch all repository fields by joining
 * the repositories and users tables based on owner username and repository name.
 *
 * @param owner - The username of the repository owner
 * @param repo - The name of the repository
 * @returns The full Repository object if found, or null if the repository does not exist
 *
 * @example
 * const repository = await getRepoByOwnerAndName('octocat', 'hello-world');
 * if (repository) {
 *   console.log(`Stars: ${repository.stars_count}`);
 * }
 */
export async function getRepoByOwnerAndName(owner: string, repo: string): Promise<Repository | null> {
  const result = await query(
    `SELECT r.* FROM repositories r
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2`,
    [owner, repo]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0] as Repository;
}

/**
 * Sends a standardized 404 response for repository not found errors.
 *
 * @description Helper function to send a consistent JSON error response
 * when a repository cannot be found.
 *
 * @param res - The Express response object
 * @returns void
 */
export function sendRepoNotFound(res: Response): void {
  res.status(404).json({ error: 'Repository not found' });
}

/**
 * Checks if a user is the owner of a repository.
 *
 * @description Compares the repository's owner_id with the provided user ID
 * to determine ownership.
 *
 * @param repo - The repository object to check
 * @param userId - The ID of the user to verify ownership for
 * @returns true if the user is the repository owner, false otherwise
 *
 * @example
 * if (isRepoOwner(repository, req.user.id)) {
 *   // Allow modification
 * }
 */
export function isRepoOwner(repo: Repository, userId: number): boolean {
  return repo.owner_id === userId;
}
