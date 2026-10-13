import { query } from '../config/database.js';
import { redis } from '../config/redis.js';
import { logger } from '../config/logger.js';
import { cacheHitsCounter, cacheMissesCounter } from '../config/metrics.js';
import { User } from '../types/index.js';

/**
 * Project permissions granted by permission schemes.
 *
 * A project points at one permission scheme; a scheme holds grants that map a permission
 * to a grantee ('anyone', a specific 'user', a project 'role', or a 'group'). A user holds
 * a permission in a project when at least one grant matches them. There are no negative
 * grants: no match means no access.
 */
export const PERMISSIONS = [
  'view_issue',
  'create_issue',
  'edit_issue',
  'delete_issue',
  'transition_issue',
  'assign_issue',
  'add_comment',
  'manage_sprints',
  'project_admin',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export interface PermissionGrantRow {
  permission: string;
  grantee_type: string;
  grantee_id: string | null;
}

/** Seconds a computed permission set may be served from Redis. */
const CACHE_TTL_SECONDS = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Evaluates a scheme's grants for one user. Pure, so the same rule serves single-project
 * checks and the visible-project set used to filter search.
 * Group grants never match: this project has no group directory to resolve them against.
 */
export function evaluateGrants(
  grants: PermissionGrantRow[],
  subject: { userId: string; roles: string[] }
): Set<Permission> {
  const held = new Set<Permission>();
  for (const grant of grants) {
    if (!isPermission(grant.permission)) continue;
    const matches =
      grant.grantee_type === 'anyone' ||
      (grant.grantee_type === 'user' && grant.grantee_id === subject.userId) ||
      (grant.grantee_type === 'role' &&
        grant.grantee_id !== null &&
        subject.roles.includes(grant.grantee_id));
    if (matches) held.add(grant.permission);
  }
  return held;
}

const entryKey = (projectId: string, userId: string) => `jira:perms:${projectId}:${userId}`;
const generationKey = (projectId: string) => `jira:perms-gen:${projectId}`;

/**
 * Reads a cached permission set together with the project's current generation.
 * An entry written under an older generation is ignored, so an in-flight request that
 * computed permissions before a membership change cannot put stale access back.
 */
async function readCache(
  projectId: string,
  userId: string
): Promise<{ permissions: Set<Permission> | null; generation: string }> {
  const results = await redis.pipeline().get(entryKey(projectId, userId)).get(generationKey(projectId)).exec();
  const raw = results?.[0]?.[1] as string | null;
  const generation = (results?.[1]?.[1] as string | null) ?? '0';
  if (raw) {
    const entry = JSON.parse(raw) as { g: string; p: Permission[] };
    if (entry.g === generation) return { permissions: new Set(entry.p), generation };
  }
  return { permissions: null, generation };
}

async function loadFromDatabase(projectId: string, userId: string): Promise<Set<Permission>> {
  const [grants, roles] = await Promise.all([
    query<PermissionGrantRow>(
      `SELECT g.permission, g.grantee_type, g.grantee_id
       FROM projects p
       JOIN permission_grants g ON g.scheme_id = p.permission_scheme_id
       WHERE p.id = $1`,
      [projectId]
    ),
    query<{ name: string }>(
      `SELECT r.name
       FROM project_members pm
       JOIN project_roles r ON r.id = pm.role_id
       WHERE pm.project_id = $1 AND pm.user_id = $2`,
      [projectId, userId]
    ),
  ]);
  return evaluateGrants(grants.rows, { userId, roles: roles.rows.map((r) => r.name) });
}

/**
 * Returns the permissions a user holds in a project. System administrators
 * (users.role = 'admin') hold every project permission.
 *
 * Cache-aside with a 60-second bound; any membership or scheme change bumps the project's
 * generation (invalidateProjectPermissions), which revokes cached access immediately.
 * If Redis is unavailable the set is computed from PostgreSQL: slower, never wrong.
 */
export async function getProjectPermissions(
  user: Pick<User, 'id' | 'role'>,
  projectId: string
): Promise<Set<Permission>> {
  if (user.role === 'admin') return new Set(PERMISSIONS);
  if (!UUID.test(projectId)) return new Set();

  let generation: string | null = null;
  try {
    const cached = await readCache(projectId, user.id);
    generation = cached.generation;
    if (cached.permissions) {
      cacheHitsCounter.inc({ cache_type: 'permissions' });
      return cached.permissions;
    }
  } catch (error) {
    logger.warn({ err: error, projectId }, 'Permission cache read failed, using database');
  }

  cacheMissesCounter.inc({ cache_type: 'permissions' });
  const permissions = await loadFromDatabase(projectId, user.id);

  if (generation !== null) {
    const entry = JSON.stringify({ g: generation, p: [...permissions] });
    redis.set(entryKey(projectId, user.id), entry, 'EX', CACHE_TTL_SECONDS).catch((error: Error) => {
      logger.warn({ err: error, projectId }, 'Permission cache write failed');
    });
  }
  return permissions;
}

/**
 * Revokes every cached permission set for a project (membership or scheme changed).
 * Call it after the database change commits. If Redis is unreachable the change still
 * takes effect once the cached entries expire (CACHE_TTL_SECONDS).
 */
export async function invalidateProjectPermissions(projectId: string): Promise<void> {
  try {
    await redis.incr(generationKey(projectId));
  } catch (error) {
    logger.error({ err: error, projectId }, 'Permission cache invalidation failed; entries expire within the TTL');
  }
}

/**
 * IDs of projects whose issues the user may view, or null for "every project" (system
 * administrators). Evaluated with the same evaluateGrants rule as single-project checks,
 * so search filtering and API authorization cannot drift apart.
 */
export async function getVisibleProjectIds(user: Pick<User, 'id' | 'role'>): Promise<string[] | null> {
  if (user.role === 'admin') return null;

  const [grants, memberships] = await Promise.all([
    query<PermissionGrantRow & { project_id: string }>(
      `SELECT p.id AS project_id, g.permission, g.grantee_type, g.grantee_id
       FROM projects p
       JOIN permission_grants g ON g.scheme_id = p.permission_scheme_id
       WHERE g.permission = 'view_issue'`
    ),
    query<{ project_id: string; name: string }>(
      `SELECT pm.project_id, r.name
       FROM project_members pm
       JOIN project_roles r ON r.id = pm.role_id
       WHERE pm.user_id = $1`,
      [user.id]
    ),
  ]);

  const grantsByProject = new Map<string, PermissionGrantRow[]>();
  for (const row of grants.rows) {
    const list = grantsByProject.get(row.project_id) ?? [];
    list.push(row);
    grantsByProject.set(row.project_id, list);
  }
  const rolesByProject = new Map<string, string[]>();
  for (const row of memberships.rows) {
    const list = rolesByProject.get(row.project_id) ?? [];
    list.push(row.name);
    rolesByProject.set(row.project_id, list);
  }

  const visible: string[] = [];
  for (const [projectId, projectGrants] of grantsByProject) {
    const held = evaluateGrants(projectGrants, {
      userId: user.id,
      roles: rolesByProject.get(projectId) ?? [],
    });
    if (held.has('view_issue')) visible.push(projectId);
  }
  return visible;
}
