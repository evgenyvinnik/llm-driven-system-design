/**
 * @fileoverview Page routes: the page tree, page snapshots and sharing.
 * Every route resolves the caller's effective permission through the page
 * tree (services/permissions.ts): the nearest explicit grant on the page or
 * an ancestor wins, otherwise the workspace role decides.
 */

import { Router, Request, Response } from 'express';
import pool from '../models/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { generateKeyBetween, PositionError } from '../utils/fractionalIndex.js';
import type { Page } from '../types/index.js';
import {
  cacheAside,
  invalidatePageCache,
  invalidateWorkspaceCache,
  CACHE_KEYS,
  CACHE_TTL,
} from '../shared/cache.js';
import { pageLoadsCounter, pageEditsCounter, pageLoadDuration } from '../shared/metrics.js';
import { auditLogger } from '../shared/audit.js';
import {
  GRANT_LEVELS,
  type GrantLevel,
  getPageAccess,
  getWorkspaceRole,
  grantPageAccess,
  hasPermission,
  isPageInSubtree,
  isUuid,
  listPageGrants,
  listVisibleAncestors,
  listVisiblePages,
  requirePageAccess,
  revokePageAccess,
} from '../services/permissions.js';
import { loadPageSnapshot, type PageSnapshot } from '../services/pageOperations.js';
import { HttpError, sendError } from '../utils/httpError.js';

const router = Router();

// Apply authentication to all page routes
router.use(authMiddleware);

function userAgent(req: Request): string | null {
  const header = req.headers['user-agent'];
  return (Array.isArray(header) ? header[0] : header) || null;
}

/**
 * Position at the end of a parent's children, or right after `afterPageId`
 * when that page is a sibling.
 */
async function pagePosition(workspaceId: string, parentId: string | null, afterPageId: unknown): Promise<string> {
  const siblings = await pool.query<{ id: string; position: string }>(
    `SELECT id, position FROM pages
     WHERE workspace_id = $1 AND parent_id IS NOT DISTINCT FROM $2
     ORDER BY position, id`,
    [workspaceId, parentId]
  );
  const rows = siblings.rows;
  const last = rows[rows.length - 1]?.position ?? null;
  const index = isUuid(afterPageId) ? rows.findIndex((row) => row.id === afterPageId) : -1;
  if (index === -1) return generateKeyBetween(last, null);
  try {
    return generateKeyBetween(rows[index].position, rows[index + 1]?.position ?? null);
  } catch (error) {
    if (!(error instanceof PositionError)) throw error;
    return generateKeyBetween(last, null); // no gap left: append instead
  }
}

/**
 * Validates a new parent for a page: same workspace, edit permission on it,
 * and not the page itself or one of its descendants (that would be a cycle).
 */
async function assertValidParent(
  userId: string,
  workspaceId: string,
  parentId: string,
  movingPageId: string | null
): Promise<void> {
  const parent = await getPageAccess(userId, parentId);
  if (!parent || parent.page.workspace_id !== workspaceId) {
    throw new HttpError(400, 'parent_id must be a page in the same workspace');
  }
  if (!hasPermission(parent.permission, 'edit')) {
    throw new HttpError(403, 'You need edit permission on the parent page');
  }
  if (movingPageId && (await isPageInSubtree(movingPageId, parentId))) {
    throw new HttpError(400, 'A page cannot be moved under itself or its own subpages');
  }
}

/**
 * GET /api/pages?workspace_id=...
 * Lists the pages of a workspace the caller can see, each with its effective
 * `permission`. Guests only receive the subtrees shared with them.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { workspace_id, parent_id, is_database } = req.query;
    const role = isUuid(workspace_id) ? await getWorkspaceRole(req.user!.id, workspace_id) : null;
    if (!role) {
      res.status(403).json({ error: 'Not a member of this workspace' });
      return;
    }

    let pages = await listVisiblePages(req.user!.id, workspace_id as string, role);
    if (parent_id !== undefined) {
      const wanted = parent_id === 'null' || parent_id === '' ? null : parent_id;
      pages = pages.filter((page) => page.parent_id === wanted);
    }
    if (is_database !== undefined) {
      pages = pages.filter((page) => page.is_database === (is_database === 'true'));
    }

    res.json({ pages });
  } catch (error) {
    sendError(res, error, 'Failed to get pages');
  }
});

/**
 * POST /api/pages
 * Creates a page or database. Root pages need a member or admin role; nested
 * pages need edit permission on the parent, which must be in the same
 * workspace.
 */
router.post('/', async (req: Request, res: Response) => {
  const { workspace_id, parent_id, title, icon, is_database, properties_schema, after_page_id } =
    req.body ?? {};

  try {
    const role = isUuid(workspace_id) ? await getWorkspaceRole(req.user!.id, workspace_id) : null;
    if (!role) {
      res.status(403).json({ error: 'Not a member of this workspace' });
      return;
    }

    const parentId: string | null = parent_id || null;
    if (parentId) {
      await assertValidParent(req.user!.id, workspace_id, parentId, null);
    } else if (role === 'guest') {
      res.status(403).json({ error: 'Guests can only create pages inside pages shared with them' });
      return;
    }

    const position = await pagePosition(workspace_id, parentId, after_page_id);

    // The page and its default database view commit together.
    const client = await pool.connect();
    let page: Page;
    try {
      await client.query('BEGIN');
      const result = await client.query<Page>(
        `INSERT INTO pages (workspace_id, parent_id, title, icon, is_database, properties_schema, position, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          workspace_id,
          parentId,
          title || 'Untitled',
          icon || null,
          Boolean(is_database),
          JSON.stringify(properties_schema || []),
          position,
          req.user!.id,
        ]
      );
      page = result.rows[0];
      if (is_database) {
        await client.query(
          `INSERT INTO database_views (page_id, name, type) VALUES ($1, 'Default View', 'table')`,
          [page.id]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    if (parentId) await invalidatePageCache(parentId);
    await invalidateWorkspaceCache(workspace_id);
    pageEditsCounter.inc({ operation_type: 'create' });

    res.status(201).json({ page });
  } catch (error) {
    sendError(res, error, 'Failed to create page');
  }
});

/**
 * GET /api/pages/:id
 * Returns the page, a snapshot of its blocks, child pages and views, the
 * snapshot's `seq`, and the caller's `permission`. The snapshot is cached; a
 * slightly stale snapshot is harmless because the client subscribes with
 * `sinceSeq: seq` and the server replays whatever happened after it.
 */
router.get('/:id', async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const access = await requirePageAccess(req, res, req.params.id, 'view');
    if (!access) return;
    const { page, permission } = access;

    pageLoadsCounter.inc({ workspace_id: page.workspace_id });

    const snapshot = await cacheAside<PageSnapshot>(
      CACHE_KEYS.pageWithBlocks(page.id),
      CACHE_TTL.page,
      () => loadPageSnapshot(page.id, page.is_database),
      'page'
    );

    // Child pages the caller cannot see (a deeper restrictive grant) are hidden.
    let children = snapshot.children;
    if (permission !== 'full_access' && children.length > 0) {
      const visible = await Promise.all(
        children.map(async (child) => {
          const childAccess = await getPageAccess(req.user!.id, child.id);
          return childAccess && hasPermission(childAccess.permission, 'view') ? child : null;
        })
      );
      children = visible.filter((child): child is Page => child !== null);
    }

    pageLoadDuration.observe({ has_cache: 'true' }, (Date.now() - startTime) / 1000);
    res.json({ page, ...snapshot, children, permission });
  } catch (error) {
    pageLoadDuration.observe({ has_cache: 'false' }, (Date.now() - startTime) / 1000);
    sendError(res, error, 'Failed to get page');
  }
});

/**
 * PATCH /api/pages/:id
 * Updates title, icon, cover, schema, position or parent (edit permission).
 * Moving a page validates the new parent: same workspace, edit permission,
 * and not inside the page's own subtree.
 */
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const access = await requirePageAccess(req, res, req.params.id, 'edit');
    if (!access) return;
    const { page } = access;
    const { title, icon, cover_image, parent_id, position, properties_schema } = req.body ?? {};

    const updates: string[] = [];
    const values: unknown[] = [];
    const push = (column: string, value: unknown) => {
      values.push(value);
      updates.push(`${column} = $${values.length}`);
    };

    if (title !== undefined) push('title', title);
    if (icon !== undefined) push('icon', icon);
    if (cover_image !== undefined) push('cover_image', cover_image);
    if (properties_schema !== undefined) push('properties_schema', JSON.stringify(properties_schema));
    if (position !== undefined) {
      if (typeof position !== 'string' || !/^[a-z]{1,100}$/.test(position)) {
        res.status(400).json({ error: 'position must be 1-100 lowercase letters' });
        return;
      }
      push('position', position);
    }

    const parentChanged = parent_id !== undefined && (parent_id || null) !== page.parent_id;
    if (parentChanged) {
      if (parent_id) {
        await assertValidParent(req.user!.id, page.workspace_id, parent_id, page.id);
      } else if (access.role === 'guest') {
        res.status(403).json({ error: 'Guests cannot move pages to the workspace root' });
        return;
      }
      push('parent_id', parent_id || null);
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No updates provided' });
      return;
    }

    values.push(page.id);
    const result = await pool.query<Page>(
      `UPDATE pages SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );

    // The parent's cached snapshot lists this page (title, icon) as a child.
    await invalidatePageCache(page.id);
    if (page.parent_id) await invalidatePageCache(page.parent_id);
    if (parentChanged && parent_id) await invalidatePageCache(parent_id);
    await invalidateWorkspaceCache(page.workspace_id);
    pageEditsCounter.inc({ operation_type: 'update' });

    res.json({ page: result.rows[0] });
  } catch (error) {
    sendError(res, error, 'Failed to update page');
  }
});

/**
 * DELETE /api/pages/:id
 * Archives a page (edit permission), or deletes it with ?permanent=true
 * (full_access permission).
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const permanent = req.query.permanent === 'true';
    const access = await requirePageAccess(req, res, req.params.id, permanent ? 'full_access' : 'edit');
    if (!access) return;
    const { page } = access;

    if (permanent) {
      await pool.query('DELETE FROM pages WHERE id = $1', [page.id]);
    } else {
      await pool.query('UPDATE pages SET is_archived = true WHERE id = $1', [page.id]);
    }

    await auditLogger.logPageDeleted(
      req.user!.id,
      page.id,
      { title: page.title, permanent, workspaceId: page.workspace_id },
      req.ip || null,
      userAgent(req)
    );

    await invalidatePageCache(page.id);
    if (page.parent_id) await invalidatePageCache(page.parent_id);
    await invalidateWorkspaceCache(page.workspace_id);
    pageEditsCounter.inc({ operation_type: 'delete' });

    res.json({ message: permanent ? 'Page permanently deleted' : 'Page archived' });
  } catch (error) {
    sendError(res, error, 'Failed to delete page');
  }
});

/**
 * GET /api/pages/:id/tree
 * Breadcrumb from the root to this page, leaving out ancestors the caller
 * cannot see.
 */
router.get('/:id/tree', async (req: Request, res: Response) => {
  try {
    const access = await requirePageAccess(req, res, req.params.id, 'view');
    if (!access) return;
    const ancestors = await listVisibleAncestors(req.user!.id, access.page.id, access.role);
    res.json({ ancestors });
  } catch (error) {
    sendError(res, error, 'Failed to get page tree');
  }
});

/**
 * GET /api/pages/:id/permissions
 * The caller's permission plus every explicit grant that applies to the page,
 * marked `inherited` when it comes from an ancestor.
 */
router.get('/:id/permissions', async (req: Request, res: Response) => {
  try {
    const access = await requirePageAccess(req, res, req.params.id, 'view');
    if (!access) return;
    const grants = await listPageGrants(access.page.id);
    res.json({ permission: access.permission, grants });
  } catch (error) {
    sendError(res, error, 'Failed to get page permissions');
  }
});

/**
 * PUT /api/pages/:id/permissions  { email, permission: view | edit | full_access }
 * Shares the page (and, by inheritance, its subtree) with a user. Requires
 * full_access. A user outside the workspace is added as a guest.
 */
router.put('/:id/permissions', async (req: Request, res: Response) => {
  try {
    const access = await requirePageAccess(req, res, req.params.id, 'full_access');
    if (!access) return;
    const { email, permission } = req.body ?? {};
    if (typeof email !== 'string' || !email.includes('@')) {
      res.status(400).json({ error: 'email is required' });
      return;
    }
    if (!GRANT_LEVELS.includes(permission)) {
      res.status(400).json({ error: `permission must be one of ${GRANT_LEVELS.join(', ')}` });
      return;
    }

    const { userId, previous, addedAsGuest } = await grantPageAccess(
      access.page.id,
      access.page.workspace_id,
      email,
      permission as GrantLevel
    );

    await auditLogger.logPermissionChanged(
      req.user!.id,
      access.page.id,
      {
        targetUserId: userId,
        previousPermission: previous,
        newPermission: permission,
        changeType: previous ? 'modify' : 'grant',
      },
      req.ip || null,
      userAgent(req)
    );

    res.json({ grant: { page_id: access.page.id, user_id: userId, permission }, added_as_guest: addedAsGuest });
  } catch (error) {
    sendError(res, error, 'Failed to share page');
  }
});

/**
 * DELETE /api/pages/:id/permissions/:userId
 * Removes a user's explicit grant on the page (full_access). Grants on
 * ancestors still apply afterwards.
 */
router.delete('/:id/permissions/:userId', async (req: Request, res: Response) => {
  try {
    const access = await requirePageAccess(req, res, req.params.id, 'full_access');
    if (!access) return;
    if (!isUuid(req.params.userId)) {
      res.status(404).json({ error: 'Grant not found' });
      return;
    }

    const removed = await revokePageAccess(access.page.id, req.params.userId);
    if (!removed) {
      res.status(404).json({ error: 'Grant not found' });
      return;
    }

    await auditLogger.logPermissionChanged(
      req.user!.id,
      access.page.id,
      {
        targetUserId: req.params.userId,
        previousPermission: removed,
        newPermission: 'none',
        changeType: 'revoke',
      },
      req.ip || null,
      userAgent(req)
    );

    res.json({ message: 'Access removed' });
  } catch (error) {
    sendError(res, error, 'Failed to remove access');
  }
});

export default router;
