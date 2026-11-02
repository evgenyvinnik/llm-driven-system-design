import type { Request } from 'express';
import { pool } from './db.js';
import { ApiError } from './errors.js';
import { decryptSecret } from './credentials.js';
import type { ConnectionConfig } from './queryExecutor.js';

/**
 * Project-level authorization. Every project route asks this module what the
 * caller may do instead of deciding on its own:
 *
 * | Action                                                     | viewer    | editor | owner |
 * |------------------------------------------------------------|-----------|--------|-------|
 * | See project, schema, rows, saved queries, auth users       | yes       | yes    | yes   |
 * | Run SQL                                                    | read-only | yes    | yes   |
 * | DDL, row writes, saved-query and auth-user changes         | no        | yes    | yes   |
 * | Change connection settings, delete project, manage members | no        | no     | yes   |
 *
 * The project's creator is always its owner. A global `users.role = 'admin'`
 * grants nothing here: membership is what puts a SQL editor in front of a
 * tenant's database. Callers with no role get 404, not 403, so project IDs
 * can't be probed for existence; members who lack the needed role get 403.
 */
export type ProjectRole = 'owner' | 'editor' | 'viewer';
export type ProjectNeed = 'view' | 'edit' | 'own';

export const PROJECT_ROLES: readonly ProjectRole[] = ['owner', 'editor', 'viewer'];

export interface ProjectAccess {
  projectId: string;
  role: ProjectRole;
  createdBy: string | null;
  canEdit: boolean;
  canOwn: boolean;
  /** Decrypted target connection settings (decrypted lazily: most routes never need the password). */
  connection(): ConnectionConfig;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isProjectRole(value: unknown): value is ProjectRole {
  return typeof value === 'string' && (PROJECT_ROLES as readonly string[]).includes(value);
}

/** The caller's access to a project, or null if the project doesn't exist or the caller has no role in it. */
export async function getProjectAccess(projectId: string, userId: string | undefined): Promise<ProjectAccess | null> {
  if (!userId || !isUuid(projectId)) return null;
  const result = await pool.query(
    `SELECT p.id, p.created_by, p.db_host, p.db_port, p.db_name, p.db_user, p.db_password, pm.role AS member_role
     FROM projects p
     LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $2
     WHERE p.id = $1`,
    [projectId, userId],
  );
  const row = result.rows[0];
  if (!row) return null;

  const role: ProjectRole | null =
    row.created_by === userId ? 'owner' : isProjectRole(row.member_role) ? row.member_role : null;
  if (!role) return null;

  return {
    projectId: row.id,
    role,
    createdBy: row.created_by,
    canEdit: role === 'owner' || role === 'editor',
    canOwn: role === 'owner',
    connection: () => ({
      host: row.db_host,
      port: row.db_port,
      database: row.db_name,
      user: row.db_user,
      password: decryptSecret(row.db_password),
    }),
  };
}

/**
 * The caller's access to the project named by `:projectId` (or `:id`), or an
 * ApiError: 404 when they can't see it, 403 when their role is too low.
 */
export async function requireProject(req: Request, need: ProjectNeed): Promise<ProjectAccess> {
  const projectId = req.params.projectId ?? req.params.id;
  const access = await getProjectAccess(projectId, req.session?.userId);
  if (!access) throw new ApiError(404, 'Project not found');
  if (need === 'edit' && !access.canEdit) {
    throw new ApiError(403, 'Viewers cannot modify this project');
  }
  if (need === 'own' && !access.canOwn) {
    throw new ApiError(403, 'Only project owners can do this');
  }
  return access;
}
