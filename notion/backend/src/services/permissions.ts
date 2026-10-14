/**
 * @fileoverview Page permissions with inheritance down the page tree.
 *
 * Effective access to a page is decided in two steps:
 *  1. The nearest explicit grant in `page_permissions` on the page itself or on
 *     any ancestor wins. A grant on "Engineering" covers every page beneath it;
 *     a deeper grant overrides it for its own subtree, in either direction.
 *  2. Without a grant, the workspace role decides: members can edit, guests see
 *     nothing they were not shared into.
 * Workspace admins always have full access, so a workspace cannot lock out its
 * own administrators.
 *
 * Resolution walks UP the tree on every check (one recursive CTE) instead of
 * materializing effective permissions per page on write. A grant, a revoke or a
 * page move is then a single-row write; the price is a short walk on each read.
 */

import type { Request, Response } from 'express';
import type { Pool, PoolClient } from 'pg';
import pool from '../models/db.js';
import { HttpError } from '../utils/httpError.js';
import type { Page } from '../types/index.js';

export type WorkspaceRole = 'admin' | 'member' | 'guest';
export type GrantLevel = 'view' | 'edit' | 'full_access';
export type PermissionLevel = 'none' | GrantLevel;

type Queryable = Pool | PoolClient;

const RANK: Record<PermissionLevel, number> = { none: 0, view: 1, edit: 2, full_access: 3 };

export const GRANT_LEVELS: readonly GrantLevel[] = ['view', 'edit', 'full_access'];

/** Deepest ancestor chain walked; also stops a corrupted (cyclic) tree. */
export const MAX_PAGE_DEPTH = 64;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a syntactically valid UUID (avoids 500s from malformed ids). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Effective permission from the workspace role and the nearest explicit grant.
 */
export function resolvePermission(
  role: WorkspaceRole | null,
  nearestGrant: GrantLevel | null
): PermissionLevel {
  if (!role) return 'none';
  if (role === 'admin') return 'full_access';
  if (nearestGrant) return nearestGrant;
  return role === 'member' ? 'edit' : 'none';
}

/** True when `actual` is at least `needed`. */
export function hasPermission(actual: PermissionLevel, needed: PermissionLevel): boolean {
  return RANK[actual] >= RANK[needed];
}

/**
 * Effective permission for every page of a root-to-leaf chain, given each
 * page's own explicit grant (or null). The nearest grant at or above a page is
 * carried down the chain.
 */
export function resolveChain(
  role: WorkspaceRole | null,
  grantsRootToLeaf: Array<GrantLevel | null>
): PermissionLevel[] {
  let inherited: GrantLevel | null = null;
  return grantsRootToLeaf.map((grant) => {
    inherited = grant ?? inherited;
    return resolvePermission(role, inherited);
  });
}

/** A page plus the caller's role and effective permission on it. */
export interface PageAccess {
  page: Page;
  role: WorkspaceRole | null;
  permission: PermissionLevel;
}

type PageRowWithAccess = Page & {
  member_role: WorkspaceRole | null;
  nearest_grant: GrantLevel | null;
};

/** Recursive CTE that walks from page $1 up to its root, same workspace only. */
const ANCESTOR_CHAIN = `
  WITH RECURSIVE chain AS (
    SELECT id, parent_id, workspace_id, 0 AS depth, ARRAY[id] AS path
    FROM pages WHERE id = $1
    UNION ALL
    SELECT p.id, p.parent_id, p.workspace_id, c.depth + 1, c.path || p.id
    FROM pages p JOIN chain c ON p.id = c.parent_id
    WHERE p.workspace_id = c.workspace_id
      AND NOT p.id = ANY(c.path)
      AND c.depth < ${MAX_PAGE_DEPTH}
  )`;

/**
 * Loads a page and the caller's effective permission in one round trip.
 *
 * @returns null when the page does not exist
 */
export async function getPageAccess(
  userId: string,
  pageId: string,
  db: Queryable = pool
): Promise<PageAccess | null> {
  if (!isUuid(pageId)) return null;

  const result = await db.query<PageRowWithAccess>(
    `${ANCESTOR_CHAIN}
     SELECT p.*,
       (SELECT wm.role FROM workspace_members wm
         WHERE wm.workspace_id = p.workspace_id AND wm.user_id = $2) AS member_role,
       (SELECT pp.permission FROM chain c
         JOIN page_permissions pp ON pp.page_id = c.id AND pp.user_id = $2
         ORDER BY c.depth LIMIT 1) AS nearest_grant
     FROM pages p WHERE p.id = $1`,
    [pageId, userId]
  );

  if (result.rows.length === 0) return null;
  const { member_role, nearest_grant, ...page } = result.rows[0];
  return {
    page: page as Page,
    role: member_role,
    permission: resolvePermission(member_role, nearest_grant),
  };
}

/**
 * Route helper: loads the page and checks the caller's permission, sending a
 * 404 or 403 itself when the check fails.
 *
 * @returns the access record, or null when a response was already sent
 */
export async function requirePageAccess(
  req: Request,
  res: Response,
  pageId: unknown,
  needed: GrantLevel
): Promise<PageAccess | null> {
  const access = isUuid(pageId) ? await getPageAccess(req.user!.id, pageId) : null;
  if (!access) {
    res.status(404).json({ error: 'Page not found' });
    return null;
  }
  if (!hasPermission(access.permission, needed)) {
    res.status(403).json({
      error:
        access.permission === 'none'
          ? 'You do not have access to this page'
          : `This action requires ${needed} permission on the page`,
      permission: access.permission,
    });
    return null;
  }
  return access;
}

/** The caller's role in a workspace, or null when not a member. */
export async function getWorkspaceRole(
  userId: string,
  workspaceId: string,
  db: Queryable = pool
): Promise<WorkspaceRole | null> {
  if (!isUuid(workspaceId)) return null;
  const result = await db.query<{ role: WorkspaceRole }>(
    'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
    [workspaceId, userId]
  );
  return result.rows[0]?.role ?? null;
}

/**
 * Every non-archived page in a workspace the user can at least view, each with
 * its effective permission. One recursive CTE walks DOWN from the roots and
 * carries the nearest grant to each child; archived pages hide their subtree.
 */
export async function listVisiblePages(
  userId: string,
  workspaceId: string,
  role: WorkspaceRole
): Promise<Array<Page & { permission: PermissionLevel }>> {
  const result = await pool.query<Page & { nearest_grant: GrantLevel | null }>(
    `WITH RECURSIVE tree AS (
       SELECT p.id, pp.permission::text AS nearest_grant, 0 AS depth
       FROM pages p
       LEFT JOIN page_permissions pp ON pp.page_id = p.id AND pp.user_id = $2
       WHERE p.workspace_id = $1 AND p.parent_id IS NULL AND p.is_archived = false
       UNION ALL
       SELECT c.id, COALESCE(pp.permission::text, t.nearest_grant), t.depth + 1
       FROM tree t
       JOIN pages c ON c.parent_id = t.id AND c.workspace_id = $1 AND c.is_archived = false
       LEFT JOIN page_permissions pp ON pp.page_id = c.id AND pp.user_id = $2
       WHERE t.depth < ${MAX_PAGE_DEPTH}
     )
     SELECT p.*, t.nearest_grant
     FROM tree t JOIN pages p ON p.id = t.id
     ORDER BY p.position, p.id`,
    [workspaceId, userId]
  );

  return result.rows
    .map(({ nearest_grant, ...page }) => ({
      ...(page as Page),
      permission: resolvePermission(role, nearest_grant),
    }))
    .filter((page) => page.permission !== 'none');
}

/**
 * Breadcrumb for a page (root first), leaving out ancestors the user cannot
 * see: a guest shared into a subtree must not learn the titles above it.
 */
export async function listVisibleAncestors(
  userId: string,
  pageId: string,
  role: WorkspaceRole | null
): Promise<Page[]> {
  const result = await pool.query<Page & { depth: number; page_grant: GrantLevel | null }>(
    `${ANCESTOR_CHAIN}
     SELECT p.*, c.depth, pp.permission AS page_grant
     FROM chain c
     JOIN pages p ON p.id = c.id
     LEFT JOIN page_permissions pp ON pp.page_id = c.id AND pp.user_id = $2
     ORDER BY c.depth DESC`,
    [pageId, userId]
  );

  const permissions = resolveChain(role, result.rows.map((row) => row.page_grant));
  return result.rows
    .filter((_, index) => permissions[index] !== 'none')
    .map(({ depth: _depth, page_grant: _grant, ...page }) => page as Page);
}

/**
 * True when `candidateId` is `rootId` itself or one of its descendants. Used to
 * reject moving a page under its own subtree, which would create a cycle.
 */
export async function isPageInSubtree(
  rootId: string,
  candidateId: string,
  db: Queryable = pool
): Promise<boolean> {
  const result = await db.query(
    `${ANCESTOR_CHAIN}
     SELECT 1 FROM chain WHERE id = $2 LIMIT 1`,
    [candidateId, rootId]
  );
  return result.rows.length > 0;
}

/** One user's effective grant on a page, and where it comes from. */
export interface PageGrant {
  user_id: string;
  email: string;
  name: string;
  permission: GrantLevel;
  inherited: boolean;
  granted_on: string;
  granted_on_title: string;
}

/**
 * Explicit grants that apply to a page: its own, plus the nearest inherited
 * grant per user from its ancestors.
 */
export async function listPageGrants(pageId: string): Promise<PageGrant[]> {
  const result = await pool.query<Omit<PageGrant, 'inherited'> & { depth: number }>(
    `${ANCESTOR_CHAIN}
     SELECT pp.user_id, u.email, u.name, pp.permission, c.depth,
            src.id AS granted_on, src.title AS granted_on_title
     FROM chain c
     JOIN page_permissions pp ON pp.page_id = c.id
     JOIN users u ON u.id = pp.user_id
     JOIN pages src ON src.id = c.id
     ORDER BY c.depth, u.email`,
    [pageId]
  );

  const seen = new Set<string>();
  const grants: PageGrant[] = [];
  for (const { depth, ...row } of result.rows) {
    if (seen.has(row.user_id)) continue; // a deeper grant already overrides it
    seen.add(row.user_id);
    grants.push({ ...row, inherited: depth > 0 });
  }
  return grants;
}

/**
 * Grants (or changes) a user's permission on a page. A user who is not yet a
 * member of the workspace is added as a guest, so sharing one page does not
 * open the rest of the workspace. Runs in one transaction.
 */
export async function grantPageAccess(
  pageId: string,
  workspaceId: string,
  email: string,
  level: GrantLevel
): Promise<{ userId: string; previous: GrantLevel | null; addedAsGuest: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query<{ id: string }>(
      'SELECT id FROM users WHERE lower(email) = lower($1)',
      [email]
    );
    if (user.rows.length === 0) {
      throw new HttpError(404, 'No user with that email');
    }
    const userId = user.rows[0].id;

    const guest = await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, 'guest')
       ON CONFLICT (workspace_id, user_id) DO NOTHING
       RETURNING user_id`,
      [workspaceId, userId]
    );

    const previous = await client.query<{ permission: GrantLevel }>(
      'SELECT permission FROM page_permissions WHERE page_id = $1 AND user_id = $2 FOR UPDATE',
      [pageId, userId]
    );

    await client.query(
      `INSERT INTO page_permissions (page_id, user_id, permission)
       VALUES ($1, $2, $3)
       ON CONFLICT (page_id, user_id) DO UPDATE SET permission = EXCLUDED.permission`,
      [pageId, userId, level]
    );

    await client.query('COMMIT');
    return {
      userId,
      previous: previous.rows[0]?.permission ?? null,
      addedAsGuest: guest.rows.length > 0,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Removes a user's explicit grant on a page.
 *
 * @returns the removed level, or null when there was no grant
 */
export async function revokePageAccess(pageId: string, userId: string): Promise<GrantLevel | null> {
  const result = await pool.query<{ permission: GrantLevel }>(
    'DELETE FROM page_permissions WHERE page_id = $1 AND user_id = $2 RETURNING permission',
    [pageId, userId]
  );
  return result.rows[0]?.permission ?? null;
}
