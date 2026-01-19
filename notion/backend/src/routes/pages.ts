/**
 * @fileoverview Page management routes for creating, reading, updating, and deleting pages.
 * Pages form a hierarchical tree structure within workspaces and can contain blocks
 * or act as databases with structured data.
 */

import { Router, Request, Response } from 'express';
import pool from '../models/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { generatePosition } from '../utils/fractionalIndex.js';
import type { Page } from '../types/index.js';
import {
  cacheAside,
  invalidatePageCache,
  invalidateWorkspaceCache,
  CACHE_KEYS,
  CACHE_TTL,
} from '../shared/cache.js';
import { pageLoadsCounter, pageEditsCounter, pageLoadDuration } from '../shared/metrics.js';
import { auditLogger, _AuditEventTypes } from '../shared/audit.js';

const router = Router();

// Apply authentication to all page routes
router.use(authMiddleware);

/**
 * GET /api/pages
 * Lists pages within a workspace, optionally filtered by parent_id or database type.
 * Returns pages ordered by their fractional index position.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { workspace_id, parent_id, is_database } = req.query;

    if (!workspace_id) {
      res.status(400).json({ error: 'workspace_id is required' });
      return;
    }

    // Check workspace membership
    const memberCheck = await pool.query(
      `SELECT role FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [workspace_id, req.user!.id]
    );

    if (memberCheck.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this workspace' });
      return;
    }

    let query = `
      SELECT * FROM pages
      WHERE workspace_id = $1 AND is_archived = false
    `;
    const params: unknown[] = [workspace_id];
    let paramIndex = 2;

    if (parent_id !== undefined) {
      if (parent_id === 'null' || parent_id === '') {
        query += ` AND parent_id IS NULL`;
      } else {
        query += ` AND parent_id = $${paramIndex++}`;
        params.push(parent_id);
      }
    }

    if (is_database !== undefined) {
      query += ` AND is_database = $${paramIndex++}`;
      params.push(is_database === 'true');
    }

    query += ` ORDER BY position`;

    const result = await pool.query<Page>(query, params);

    res.json({ pages: result.rows });
  } catch (error) {
    console.error('Get pages error:', error);
    res.status(500).json({ error: 'Failed to get pages' });
  }
});

/**
 * POST /api/pages
 * Creates a new page or database within a workspace.
 * Uses fractional indexing for position to allow O(1) insertions.
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      workspace_id,
      parent_id,
      title,
      icon,
      is_database,
      properties_schema,
      after_page_id,
    } = req.body;

    if (!workspace_id) {
      res.status(400).json({ error: 'workspace_id is required' });
      return;
    }

    // Check workspace membership
    const memberCheck = await pool.query(
      `SELECT role FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [workspace_id, req.user!.id]
    );

    if (memberCheck.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this workspace' });
      return;
    }

    // Calculate position
    let position = 'n';
    if (after_page_id) {
      // Get the page we're inserting after
      const afterPage = await pool.query<Page>(
        'SELECT position FROM pages WHERE id = $1',
        [after_page_id]
      );

      if (afterPage.rows.length > 0) {
        // Get the next sibling
        const nextSibling = await pool.query<Page>(
          `SELECT position FROM pages
           WHERE workspace_id = $1 AND parent_id ${parent_id ? '= $2' : 'IS NULL'}
           AND position > $${parent_id ? 3 : 2}
           ORDER BY position LIMIT 1`,
          parent_id
            ? [workspace_id, parent_id, afterPage.rows[0].position]
            : [workspace_id, afterPage.rows[0].position]
        );

        position = generatePosition(
          afterPage.rows[0].position,
          nextSibling.rows[0]?.position || ''
        );
      }
    } else {
      // Insert at the end
      const lastPage = await pool.query<Page>(
        `SELECT position FROM pages
         WHERE workspace_id = $1 AND parent_id ${parent_id ? '= $2' : 'IS NULL'}
         ORDER BY position DESC LIMIT 1`,
        parent_id ? [workspace_id, parent_id] : [workspace_id]
      );

      position = generatePosition(lastPage.rows[0]?.position || '', '');
    }

    const result = await pool.query<Page>(
      `INSERT INTO pages (workspace_id, parent_id, title, icon, is_database, properties_schema, position, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        workspace_id,
        parent_id || null,
        title || 'Untitled',
        icon || null,
        is_database || false,
        JSON.stringify(properties_schema || []),
        position,
        req.user!.id,
      ]
    );

    const page = result.rows[0];

    // If it's a database, create a default view
    if (is_database) {
      await pool.query(
        `INSERT INTO database_views (page_id, name, type)
         VALUES ($1, $2, $3)`,
        [page.id, 'Default View', 'table']
      );
    }

    // Invalidate parent page cache if nested, and workspace cache
    if (parent_id) {
      await invalidatePageCache(parent_id as string);
    }
    await invalidateWorkspaceCache(workspace_id as string);

    // Track metrics
    pageEditsCounter.inc({ operation_type: 'create' });

    res.status(201).json({ page });
  } catch (error) {
    console.error('Create page error:', error);
    res.status(500).json({ error: 'Failed to create page' });
  }
});

/**
 * GET /api/pages/:id
 * Gets a specific page with its blocks, child pages, and database views.
 * Uses cache-aside pattern for frequently accessed pages.
 */
router.get('/:id', async (req: Request, res: Response) => {
  const startTime = Date.now();
  let hasCache = false;

  try {
    const { id } = req.params;

    // First check basic page existence and permissions (not cached)
    const pageResult = await pool.query<Page>(
      'SELECT * FROM pages WHERE id = $1',
      [id]
    );

    if (pageResult.rows.length === 0) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    const page = pageResult.rows[0];

    // Check workspace membership
    const memberCheck = await pool.query(
      `SELECT role FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [page.workspace_id, req.user!.id]
    );

    if (memberCheck.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this workspace' });
      return;
    }

    // Track page load metrics
    pageLoadsCounter.inc({ workspace_id: page.workspace_id });

    // Use cache-aside pattern for page content (blocks, children, views)
    const cacheKey = CACHE_KEYS.pageWithBlocks(id as string);
    const pageContent = await cacheAside(
      cacheKey,
      CACHE_TTL.page,
      async () => {
        // Get blocks for this page
        const blocksResult = await pool.query(
          `SELECT * FROM blocks
           WHERE page_id = $1
           ORDER BY position`,
          [id]
        );

        // Get child pages
        const childPagesResult = await pool.query<Page>(
          `SELECT * FROM pages
           WHERE parent_id = $1 AND is_archived = false
           ORDER BY position`,
          [id]
        );

        // If it's a database, get views
        let views: unknown[] = [];
        if (page.is_database) {
          const viewsResult = await pool.query(
            `SELECT * FROM database_views
             WHERE page_id = $1
             ORDER BY position`,
            [id]
          );
          views = viewsResult.rows;
        }

        return {
          blocks: blocksResult.rows,
          children: childPagesResult.rows,
          views,
        };
      },
      'page'
    );

    hasCache = true;
    pageLoadDuration.observe({ has_cache: hasCache ? 'true' : 'false' }, (Date.now() - startTime) / 1000);

    res.json({
      page,
      ...pageContent,
    });
  } catch (error) {
    pageLoadDuration.observe({ has_cache: hasCache ? 'true' : 'false' }, (Date.now() - startTime) / 1000);
    console.error('Get page error:', error);
    res.status(500).json({ error: 'Failed to get page' });
  }
});

/**
 * PATCH /api/pages/:id
 * Updates page properties such as title, icon, cover image, or parent.
 * Moving a page updates its position in the hierarchy.
 */
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { title, icon, cover_image, parent_id, position, properties_schema } =
      req.body;

    // Check if page exists and get workspace
    const pageResult = await pool.query<Page>(
      'SELECT * FROM pages WHERE id = $1',
      [id]
    );

    if (pageResult.rows.length === 0) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    const page = pageResult.rows[0];

    // Check workspace membership
    const memberCheck = await pool.query(
      `SELECT role FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [page.workspace_id, req.user!.id]
    );

    if (memberCheck.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this workspace' });
      return;
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (title !== undefined) {
      updates.push(`title = $${paramIndex++}`);
      values.push(title);
    }
    if (icon !== undefined) {
      updates.push(`icon = $${paramIndex++}`);
      values.push(icon);
    }
    if (cover_image !== undefined) {
      updates.push(`cover_image = $${paramIndex++}`);
      values.push(cover_image);
    }
    if (parent_id !== undefined) {
      updates.push(`parent_id = $${paramIndex++}`);
      values.push(parent_id || null);
    }
    if (position !== undefined) {
      updates.push(`position = $${paramIndex++}`);
      values.push(position);
    }
    if (properties_schema !== undefined) {
      updates.push(`properties_schema = $${paramIndex++}`);
      values.push(JSON.stringify(properties_schema));
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No updates provided' });
      return;
    }

    values.push(id);
    const result = await pool.query<Page>(
      `UPDATE pages SET ${updates.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING *`,
      values
    );

    const updatedPage = result.rows[0];

    // Invalidate page cache on update
    await invalidatePageCache(id as string);

    // If parent changed, also invalidate old and new parent caches
    if (parent_id !== undefined && parent_id !== page.parent_id) {
      if (page.parent_id) {
        await invalidatePageCache(page.parent_id);
      }
      if (parent_id) {
        await invalidatePageCache(parent_id as string);
      }
    }

    // Track metrics
    pageEditsCounter.inc({ operation_type: 'update' });

    res.json({ page: updatedPage });
  } catch (error) {
    console.error('Update page error:', error);
    res.status(500).json({ error: 'Failed to update page' });
  }
});

/**
 * DELETE /api/pages/:id
 * Archives a page by default, or permanently deletes it with ?permanent=true.
 * Archived pages can be restored later.
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { permanent } = req.query;

    const pageResult = await pool.query<Page>(
      'SELECT * FROM pages WHERE id = $1',
      [id]
    );

    if (pageResult.rows.length === 0) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    const page = pageResult.rows[0];

    // Check workspace membership
    const memberCheck = await pool.query(
      `SELECT role FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [page.workspace_id, req.user!.id]
    );

    if (memberCheck.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this workspace' });
      return;
    }

    if (permanent === 'true') {
      // Permanent delete
      await pool.query('DELETE FROM pages WHERE id = $1', [id]);

      // Audit log for permanent deletion
      await auditLogger.logPageDeleted(
        req.user!.id,
        id as string,
        {
          title: page.title,
          permanent: true,
          workspaceId: page.workspace_id,
        },
        req.ip || null,
        (Array.isArray(req.headers['user-agent']) ? req.headers['user-agent'][0] : req.headers['user-agent']) || null
      );

      res.json({ message: 'Page permanently deleted' });
    } else {
      // Soft delete (archive)
      await pool.query(
        'UPDATE pages SET is_archived = true WHERE id = $1',
        [id]
      );

      // Audit log for archive
      await auditLogger.logPageDeleted(
        req.user!.id,
        id as string,
        {
          title: page.title,
          permanent: false,
          workspaceId: page.workspace_id,
        },
        req.ip || null,
        (Array.isArray(req.headers['user-agent']) ? req.headers['user-agent'][0] : req.headers['user-agent']) || null
      );
      res.json({ message: 'Page archived' });
    }

    // Invalidate caches for deleted/archived page
    await invalidatePageCache(id as string);
    if (page.parent_id) {
      await invalidatePageCache(page.parent_id);
    }
    await invalidateWorkspaceCache(page.workspace_id);

    // Track metrics
    pageEditsCounter.inc({ operation_type: 'delete' });
  } catch (error) {
    console.error('Delete page error:', error);
    res.status(500).json({ error: 'Failed to delete page' });
  }
});

/**
 * GET /api/pages/:id/tree
 * Returns the ancestor chain (breadcrumb path) from root to this page.
 * Uses a recursive CTE for efficient hierarchy traversal.
 */
router.get('/:id/tree', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Get ancestors using recursive CTE
    const ancestorsResult = await pool.query<Page>(
      `WITH RECURSIVE ancestors AS (
         SELECT * FROM pages WHERE id = $1
         UNION ALL
         SELECT p.* FROM pages p
         JOIN ancestors a ON p.id = a.parent_id
       )
       SELECT * FROM ancestors ORDER BY created_at`,
      [id]
    );

    res.json({ ancestors: ancestorsResult.rows });
  } catch (error) {
    console.error('Get page tree error:', error);
    res.status(500).json({ error: 'Failed to get page tree' });
  }
});

export default router;
