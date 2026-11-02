import type { Request, Response } from 'express';
import { pool } from './db.js';
import { logger } from './logger.js';

/**
 * Space-level authorization. Every route asks this module what the caller may
 * do instead of deciding on its own:
 *
 * | Role            | View published | View drafts | Edit pages | Administer space |
 * |-----------------|----------------|-------------|------------|------------------|
 * | none, public    | yes            | no          | no         | no               |
 * | none, private   | no             | no          | no         | no               |
 * | viewer          | yes            | no          | no         | no               |
 * | member          | yes            | yes         | yes        | no               |
 * | admin           | yes            | yes         | yes        | yes              |
 *
 * A global admin (users.role = 'admin') is treated as admin of every space.
 * Callers that cannot view a space get 404 rather than 403, so private space
 * keys and page IDs cannot be probed for existence.
 */
export type SpaceRole = 'admin' | 'member' | 'viewer';

export interface Caller {
  userId?: string;
  globalRole?: string;
}

export interface SpaceAccess {
  spaceId: string;
  spaceKey: string;
  isPublic: boolean;
  role: SpaceRole | null;
  canView: boolean;
  canEdit: boolean;
  canAdmin: boolean;
}

export interface PageRow {
  id: string;
  space_id: string;
  parent_id: string | null;
  status: string;
  [key: string]: unknown;
}

/** A refusal with its HTTP status; routes turn it into a response. */
export class AccessError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AccessError';
  }
}

/**
 * Sends an AccessError as its own status, and anything else as a logged 500
 * with a generic message (internal errors are not echoed to clients).
 */
export function respondError(res: Response, err: unknown, fallback: string): void {
  if (err instanceof AccessError) {
    res.status(err.status).json({ error: err.message, ...err.details });
    return;
  }
  logger.error({ err }, fallback);
  res.status(500).json({ error: fallback });
}

export function callerFrom(req: Request): Caller {
  return { userId: req.session?.userId, globalRole: req.session?.role };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

async function roleIn(spaceId: string, caller: Caller): Promise<SpaceRole | null> {
  if (!caller.userId) return null;
  if (caller.globalRole === 'admin') return 'admin';
  const result = await pool.query(
    'SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2',
    [spaceId, caller.userId],
  );
  return (result.rows[0]?.role as SpaceRole | undefined) ?? null;
}

function accessFor(
  space: { id: string; key: string; is_public: boolean },
  role: SpaceRole | null,
): SpaceAccess {
  return {
    spaceId: space.id,
    spaceKey: space.key,
    isPublic: space.is_public,
    role,
    canView: role !== null || space.is_public,
    canEdit: role === 'admin' || role === 'member',
    canAdmin: role === 'admin',
  };
}

/** Access to a space by key, or null if it does not exist. */
export async function spaceAccessByKey(key: string, caller: Caller): Promise<SpaceAccess | null> {
  const result = await pool.query('SELECT id, key, is_public FROM spaces WHERE key = $1', [
    String(key).toUpperCase(),
  ]);
  const space = result.rows[0];
  if (!space) return null;
  return accessFor(space, await roleIn(space.id, caller));
}

/** Access to a space by ID, or null if it does not exist. */
export async function spaceAccessById(spaceId: string, caller: Caller): Promise<SpaceAccess | null> {
  if (!isUuid(spaceId)) return null;
  const result = await pool.query('SELECT id, key, is_public FROM spaces WHERE id = $1', [spaceId]);
  const space = result.rows[0];
  if (!space) return null;
  return accessFor(space, await roleIn(space.id, caller));
}

/** Published pages are visible to anyone who can view the space; drafts and archived pages only to editors. */
export function canSeePage(page: { status: string }, access: SpaceAccess): boolean {
  return access.canView && (page.status === 'published' || access.canEdit);
}

/**
 * Space access that the caller must have, or an AccessError: 404 when the
 * space is invisible to them, 401 when signing in could help, 403 otherwise.
 */
export async function requireSpace(
  spaceKeyOrId: { key?: string; id?: string },
  caller: Caller,
  need: 'view' | 'edit' | 'admin',
): Promise<SpaceAccess> {
  const access = spaceKeyOrId.key
    ? await spaceAccessByKey(spaceKeyOrId.key, caller)
    : await spaceAccessById(spaceKeyOrId.id ?? '', caller);
  if (!access || !access.canView) throw new AccessError(404, 'Space not found');
  return checkNeed(access, caller, need);
}

function checkNeed(access: SpaceAccess, caller: Caller, need: 'view' | 'edit' | 'admin'): SpaceAccess {
  if (need === 'view') return access;
  if (!caller.userId) throw new AccessError(401, 'Authentication required');
  if (need === 'edit' && !access.canEdit) {
    throw new AccessError(403, 'You need member access to this space to make changes');
  }
  if (need === 'admin' && !access.canAdmin) {
    throw new AccessError(403, 'Only space administrators can do this');
  }
  return access;
}

/**
 * Loads a page and checks the caller's access to it. Reads always go to
 * Postgres (not the page cache) so a status or space change can never be
 * judged against a stale cached row.
 */
export async function requirePage(
  pageId: string,
  caller: Caller,
  need: 'view' | 'edit' | 'admin',
): Promise<{ page: PageRow; access: SpaceAccess }> {
  if (!isUuid(pageId)) throw new AccessError(404, 'Page not found');
  const result = await pool.query(
    `SELECT p.id, p.space_id, p.parent_id, p.status, p.version, p.title, p.slug,
            s.key AS space_key, s.is_public
     FROM pages p JOIN spaces s ON s.id = p.space_id
     WHERE p.id = $1`,
    [pageId],
  );
  const row = result.rows[0];
  if (!row) throw new AccessError(404, 'Page not found');

  const access = accessFor(
    { id: row.space_id, key: row.space_key, is_public: row.is_public },
    await roleIn(row.space_id, caller),
  );
  if (!canSeePage(row, access)) throw new AccessError(404, 'Page not found');
  return { page: row, access: checkNeed(access, caller, need) };
}

/** IDs of every space the caller can view. */
export async function visibleSpaceIds(caller: Caller): Promise<string[]> {
  if (caller.globalRole === 'admin' && caller.userId) {
    const all = await pool.query('SELECT id FROM spaces');
    return all.rows.map((r: { id: string }) => r.id);
  }
  const result = await pool.query(
    `SELECT id FROM spaces
     WHERE is_public = true
        OR id IN (SELECT space_id FROM space_members WHERE user_id = $1)`,
    [caller.userId ?? null],
  );
  return result.rows.map((r: { id: string }) => r.id);
}

/** IDs of every space in which the caller can see drafts (member or admin). */
export async function editableSpaceIds(caller: Caller): Promise<string[]> {
  if (!caller.userId) return [];
  if (caller.globalRole === 'admin') {
    const all = await pool.query('SELECT id FROM spaces');
    return all.rows.map((r: { id: string }) => r.id);
  }
  const result = await pool.query(
    `SELECT space_id FROM space_members WHERE user_id = $1 AND role IN ('admin', 'member')`,
    [caller.userId],
  );
  return result.rows.map((r: { space_id: string }) => r.space_id);
}

/** IDs of every space the caller administers (where they can review approvals). */
export async function adminSpaceIds(caller: Caller): Promise<string[]> {
  if (!caller.userId) return [];
  if (caller.globalRole === 'admin') {
    const all = await pool.query('SELECT id FROM spaces');
    return all.rows.map((r: { id: string }) => r.id);
  }
  const result = await pool.query(
    `SELECT space_id FROM space_members WHERE user_id = $1 AND role = 'admin'`,
    [caller.userId],
  );
  return result.rows.map((r: { space_id: string }) => r.space_id);
}
