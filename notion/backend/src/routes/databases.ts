/**
 * @fileoverview Database feature routes for structured data management.
 * Databases are special pages with a properties schema and multiple views
 * (table, board, list). This module handles rows, views, and schema updates.
 * Access follows the database page's effective permission: view to read,
 * edit to change rows, views or the schema.
 */

import { Router, Request, Response } from 'express';
import pool from '../models/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { generateKeyBetween, PositionError } from '../utils/fractionalIndex.js';
import type { DatabaseView, DatabaseRow, PropertySchema } from '../types/index.js';
import { invalidatePageCache } from '../shared/cache.js';
import { isUuid, requirePageAccess, type GrantLevel, type PageAccess } from '../services/permissions.js';
import { sendError } from '../utils/httpError.js';

const router = Router();

// Apply authentication to all database routes
router.use(authMiddleware);

/**
 * Checks permission on the database page and that it really is a database.
 * Sends the error response itself and returns null on failure.
 */
async function requireDatabase(
  req: Request,
  res: Response,
  needed: GrantLevel
): Promise<PageAccess | null> {
  const access = await requirePageAccess(req, res, req.params.id, needed);
  if (!access) return null;
  if (!access.page.is_database) {
    res.status(404).json({ error: 'Database not found' });
    return null;
  }
  return access;
}

/**
 * GET /api/databases/:id
 * Gets a database with its views and rows.
 * Applies view filters and sorts (currently in-memory).
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const access = await requireDatabase(req, res, 'view');
    if (!access) return;
    const { id } = req.params;
    const { view_id } = req.query;

    const viewsResult = await pool.query<DatabaseView>(
      'SELECT * FROM database_views WHERE page_id = $1 ORDER BY position, id',
      [id]
    );

    const rowsResult = await pool.query<DatabaseRow>(
      `SELECT * FROM database_rows
       WHERE database_id = $1 AND is_archived = false
       ORDER BY position, id`,
      [id]
    );

    const activeView = view_id
      ? viewsResult.rows.find((v) => v.id === view_id)
      : viewsResult.rows[0];

    // Apply filters in memory (in production, use database-level filtering)
    let rows = rowsResult.rows;
    if (activeView?.filter && activeView.filter.length > 0) {
      rows = rows.filter((row) => {
        return activeView.filter.every((f) => {
          const value = row.properties[f.property];
          switch (f.operator) {
            case 'equals':
              return value === f.value;
            case 'not_equals':
              return value !== f.value;
            case 'contains':
              return String(value).includes(String(f.value));
            case 'is_empty':
              return !value || value === '';
            case 'is_not_empty':
              return value && value !== '';
            default:
              return true;
          }
        });
      });
    }

    // Apply sorts in memory
    if (activeView?.sort && activeView.sort.length > 0) {
      rows.sort((a, b) => {
        for (const s of activeView.sort) {
          const aVal = a.properties[s.property];
          const bVal = b.properties[s.property];
          const cmp = String(aVal || '').localeCompare(String(bVal || ''));
          if (cmp !== 0) {
            return s.direction === 'asc' ? cmp : -cmp;
          }
        }
        return 0;
      });
    }

    res.json({
      database: access.page,
      views: viewsResult.rows,
      rows,
      activeViewId: activeView?.id,
      permission: access.permission,
    });
  } catch (error) {
    sendError(res, error, 'Failed to get database');
  }
});

/**
 * POST /api/databases/:id/rows
 * Creates a new row with default property values, after `after_row_id` or at
 * the end.
 */
router.post('/:id/rows', async (req: Request, res: Response) => {
  try {
    const access = await requireDatabase(req, res, 'edit');
    if (!access) return;
    const { id } = req.params;
    const { properties, after_row_id } = req.body ?? {};

    const siblings = await pool.query<{ id: string; position: string }>(
      'SELECT id, position FROM database_rows WHERE database_id = $1 ORDER BY position, id',
      [id]
    );
    const rowsInOrder = siblings.rows;
    const last = rowsInOrder[rowsInOrder.length - 1]?.position ?? null;
    const index = isUuid(after_row_id) ? rowsInOrder.findIndex((r) => r.id === after_row_id) : -1;
    let position: string;
    try {
      position =
        index === -1
          ? generateKeyBetween(last, null)
          : generateKeyBetween(rowsInOrder[index].position, rowsInOrder[index + 1]?.position ?? null);
    } catch (error) {
      if (!(error instanceof PositionError)) throw error;
      position = generateKeyBetween(last, null);
    }

    // Set default values based on schema
    const schema = (access.page.properties_schema ?? []) as PropertySchema[];
    const rowProperties: Record<string, unknown> = {};
    for (const prop of schema) {
      if (properties && properties[prop.id] !== undefined) {
        rowProperties[prop.id] = properties[prop.id];
      } else if (prop.type === 'title') {
        rowProperties[prop.id] = 'Untitled';
      } else if (prop.type === 'checkbox') {
        rowProperties[prop.id] = false;
      } else {
        rowProperties[prop.id] = null;
      }
    }

    const result = await pool.query<DatabaseRow>(
      `INSERT INTO database_rows (database_id, properties, position, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, JSON.stringify(rowProperties), position, req.user!.id]
    );

    res.status(201).json({ row: result.rows[0] });
  } catch (error) {
    sendError(res, error, 'Failed to create row');
  }
});

/**
 * PATCH /api/databases/:id/rows/:rowId
 * Merges the given property values into the row. The merge happens inside
 * PostgreSQL (`properties || $1::jsonb`), so two people editing different
 * cells of the same row at the same time both keep their change; the old
 * read-merge-write in Node lost one of them.
 */
router.patch('/:id/rows/:rowId', async (req: Request, res: Response) => {
  try {
    const access = await requireDatabase(req, res, 'edit');
    if (!access) return;
    const { id, rowId } = req.params;
    const { properties, position } = req.body ?? {};

    if (!isUuid(rowId)) {
      res.status(404).json({ error: 'Row not found' });
      return;
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    if (properties !== undefined) {
      if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
        res.status(400).json({ error: 'properties must be an object' });
        return;
      }
      values.push(JSON.stringify(properties));
      updates.push(`properties = properties || $${values.length}::jsonb`);
    }
    if (position !== undefined) {
      if (typeof position !== 'string' || !/^[a-z]{1,100}$/.test(position)) {
        res.status(400).json({ error: 'position must be 1-100 lowercase letters' });
        return;
      }
      values.push(position);
      updates.push(`position = $${values.length}`);
    }
    if (updates.length === 0) {
      res.status(400).json({ error: 'No updates provided' });
      return;
    }

    values.push(rowId, id);
    const result = await pool.query<DatabaseRow>(
      `UPDATE database_rows SET ${updates.join(', ')}
       WHERE id = $${values.length - 1} AND database_id = $${values.length}
       RETURNING *`,
      values
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Row not found' });
      return;
    }

    res.json({ row: result.rows[0] });
  } catch (error) {
    sendError(res, error, 'Failed to update row');
  }
});

/**
 * DELETE /api/databases/:id/rows/:rowId
 * Archives a row by default, or permanently deletes with ?permanent=true.
 */
router.delete('/:id/rows/:rowId', async (req: Request, res: Response) => {
  try {
    const access = await requireDatabase(req, res, 'edit');
    if (!access) return;
    const { id, rowId } = req.params;
    if (!isUuid(rowId)) {
      res.status(404).json({ error: 'Row not found' });
      return;
    }

    const result =
      req.query.permanent === 'true'
        ? await pool.query('DELETE FROM database_rows WHERE id = $1 AND database_id = $2', [rowId, id])
        : await pool.query(
            'UPDATE database_rows SET is_archived = true WHERE id = $1 AND database_id = $2',
            [rowId, id]
          );
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Row not found' });
      return;
    }

    res.json({ message: req.query.permanent === 'true' ? 'Row permanently deleted' : 'Row archived' });
  } catch (error) {
    sendError(res, error, 'Failed to delete row');
  }
});

/**
 * POST /api/databases/:id/views
 * Creates a new view for the database (table, board, list, etc.).
 * Each view has its own filter, sort, and display settings.
 */
router.post('/:id/views', async (req: Request, res: Response) => {
  try {
    const access = await requireDatabase(req, res, 'edit');
    if (!access) return;
    const { id } = req.params;
    const { name, type, filter, sort, group_by, properties_visibility } = req.body ?? {};

    const lastView = await pool.query<DatabaseView>(
      'SELECT position FROM database_views WHERE page_id = $1 ORDER BY position DESC, id DESC LIMIT 1',
      [id]
    );
    const position = generateKeyBetween(lastView.rows[0]?.position ?? null, null);

    const result = await pool.query<DatabaseView>(
      `INSERT INTO database_views (page_id, name, type, filter, sort, group_by, properties_visibility, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        id,
        name || 'New View',
        type || 'table',
        JSON.stringify(filter || []),
        JSON.stringify(sort || []),
        group_by || null,
        JSON.stringify(properties_visibility || []),
        position,
      ]
    );

    // Views are part of the cached page snapshot.
    await invalidatePageCache(access.page.id);
    res.status(201).json({ view: result.rows[0] });
  } catch (error) {
    sendError(res, error, 'Failed to create view');
  }
});

/**
 * PATCH /api/databases/:id/views/:viewId
 * Updates view settings (name, type, filters, sorts, etc.).
 */
router.patch('/:id/views/:viewId', async (req: Request, res: Response) => {
  try {
    const access = await requireDatabase(req, res, 'edit');
    if (!access) return;
    const { id, viewId } = req.params;
    const { name, type, filter, sort, group_by, properties_visibility, position } = req.body ?? {};

    if (!isUuid(viewId)) {
      res.status(404).json({ error: 'View not found' });
      return;
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    const push = (column: string, value: unknown) => {
      values.push(value);
      updates.push(`${column} = $${values.length}`);
    };

    if (name !== undefined) push('name', name);
    if (type !== undefined) push('type', type);
    if (filter !== undefined) push('filter', JSON.stringify(filter));
    if (sort !== undefined) push('sort', JSON.stringify(sort));
    if (group_by !== undefined) push('group_by', group_by);
    if (properties_visibility !== undefined) push('properties_visibility', JSON.stringify(properties_visibility));
    if (position !== undefined) push('position', position);

    if (updates.length === 0) {
      res.status(400).json({ error: 'No updates provided' });
      return;
    }

    values.push(viewId, id);
    const result = await pool.query<DatabaseView>(
      `UPDATE database_views SET ${updates.join(', ')}
       WHERE id = $${values.length - 1} AND page_id = $${values.length}
       RETURNING *`,
      values
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'View not found' });
      return;
    }

    await invalidatePageCache(access.page.id);
    res.json({ view: result.rows[0] });
  } catch (error) {
    sendError(res, error, 'Failed to update view');
  }
});

/**
 * DELETE /api/databases/:id/views/:viewId
 * Deletes a view of THIS database (the id pair is checked together, so a view
 * of another workspace's database cannot be deleted through your own database).
 * The last remaining view cannot be deleted.
 */
router.delete('/:id/views/:viewId', async (req: Request, res: Response) => {
  try {
    const access = await requireDatabase(req, res, 'edit');
    if (!access) return;
    const { id, viewId } = req.params;
    if (!isUuid(viewId)) {
      res.status(404).json({ error: 'View not found' });
      return;
    }

    const result = await pool.query(
      `DELETE FROM database_views
       WHERE id = $1 AND page_id = $2
         AND (SELECT COUNT(*) FROM database_views WHERE page_id = $2) > 1`,
      [viewId, id]
    );
    if (result.rowCount === 0) {
      const exists = await pool.query('SELECT 1 FROM database_views WHERE id = $1 AND page_id = $2', [viewId, id]);
      res
        .status(exists.rows.length > 0 ? 400 : 404)
        .json({ error: exists.rows.length > 0 ? 'Cannot delete the last view' : 'View not found' });
      return;
    }

    await invalidatePageCache(access.page.id);
    res.json({ message: 'View deleted' });
  } catch (error) {
    sendError(res, error, 'Failed to delete view');
  }
});

/**
 * PATCH /api/databases/:id/schema
 * Updates the database properties schema (column definitions).
 */
router.patch('/:id/schema', async (req: Request, res: Response) => {
  try {
    const access = await requireDatabase(req, res, 'edit');
    if (!access) return;
    const { properties_schema } = req.body ?? {};
    if (!Array.isArray(properties_schema)) {
      res.status(400).json({ error: 'properties_schema must be an array' });
      return;
    }

    const result = await pool.query(
      'UPDATE pages SET properties_schema = $1 WHERE id = $2 RETURNING *',
      [JSON.stringify(properties_schema), req.params.id]
    );

    await invalidatePageCache(access.page.id);
    res.json({ database: result.rows[0] });
  } catch (error) {
    sendError(res, error, 'Failed to update schema');
  }
});

export default router;
