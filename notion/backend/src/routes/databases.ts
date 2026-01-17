import { Router, Request, Response } from 'express';
import pool from '../models/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { generatePosition } from '../utils/fractionalIndex.js';
import type { DatabaseView, DatabaseRow, Page, PropertySchema } from '../types/index.js';

const router = Router();

// All database routes require authentication
router.use(authMiddleware);

/**
 * GET /api/databases/:id
 * Get a database with its views and rows
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { view_id } = req.query;

    // Get database page
    const pageResult = await pool.query<Page>(
      'SELECT * FROM pages WHERE id = $1 AND is_database = true',
      [id]
    );

    if (pageResult.rows.length === 0) {
      res.status(404).json({ error: 'Database not found' });
      return;
    }

    const database = pageResult.rows[0];

    // Check workspace membership
    const memberCheck = await pool.query(
      `SELECT role FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [database.workspace_id, req.user!.id]
    );

    if (memberCheck.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this workspace' });
      return;
    }

    // Get views
    const viewsResult = await pool.query<DatabaseView>(
      'SELECT * FROM database_views WHERE page_id = $1 ORDER BY position',
      [id]
    );

    // Get rows
    let rowsQuery = `
      SELECT * FROM database_rows
      WHERE database_id = $1 AND is_archived = false
    `;
    const rowsParams: unknown[] = [id];

    // Apply view filters and sorts if specified
    const activeView = view_id
      ? viewsResult.rows.find((v) => v.id === view_id)
      : viewsResult.rows[0];

    if (activeView?.sort && activeView.sort.length > 0) {
      // For now, we'll sort in memory since JSONB sorting is complex
      // In production, you'd use proper JSONB operators
    }

    rowsQuery += ' ORDER BY position';

    const rowsResult = await pool.query<DatabaseRow>(rowsQuery, rowsParams);

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
      database,
      views: viewsResult.rows,
      rows,
      activeViewId: activeView?.id,
    });
  } catch (error) {
    console.error('Get database error:', error);
    res.status(500).json({ error: 'Failed to get database' });
  }
});

/**
 * POST /api/databases/:id/rows
 * Create a new database row
 */
router.post('/:id/rows', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { properties, after_row_id } = req.body;

    // Get database page
    const pageResult = await pool.query<Page>(
      'SELECT * FROM pages WHERE id = $1 AND is_database = true',
      [id]
    );

    if (pageResult.rows.length === 0) {
      res.status(404).json({ error: 'Database not found' });
      return;
    }

    const database = pageResult.rows[0];

    // Check workspace membership
    const memberCheck = await pool.query(
      `SELECT role FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [database.workspace_id, req.user!.id]
    );

    if (memberCheck.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this workspace' });
      return;
    }

    // Calculate position
    let position = 'n';
    if (after_row_id) {
      const afterRow = await pool.query<DatabaseRow>(
        'SELECT position FROM database_rows WHERE id = $1',
        [after_row_id]
      );

      if (afterRow.rows.length > 0) {
        const nextRow = await pool.query<DatabaseRow>(
          `SELECT position FROM database_rows
           WHERE database_id = $1 AND position > $2
           ORDER BY position LIMIT 1`,
          [id, afterRow.rows[0].position]
        );

        position = generatePosition(
          afterRow.rows[0].position,
          nextRow.rows[0]?.position || ''
        );
      }
    } else {
      const lastRow = await pool.query<DatabaseRow>(
        `SELECT position FROM database_rows
         WHERE database_id = $1
         ORDER BY position DESC LIMIT 1`,
        [id]
      );

      position = generatePosition(lastRow.rows[0]?.position || '', '');
    }

    // Set default values based on schema
    const schema = database.properties_schema as PropertySchema[];
    const rowProperties: Record<string, unknown> = {};

    for (const prop of schema) {
      if (properties && properties[prop.id] !== undefined) {
        rowProperties[prop.id] = properties[prop.id];
      } else {
        // Default values
        switch (prop.type) {
          case 'title':
            rowProperties[prop.id] = 'Untitled';
            break;
          case 'checkbox':
            rowProperties[prop.id] = false;
            break;
          case 'number':
            rowProperties[prop.id] = null;
            break;
          default:
            rowProperties[prop.id] = null;
        }
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
    console.error('Create row error:', error);
    res.status(500).json({ error: 'Failed to create row' });
  }
});

/**
 * PATCH /api/databases/:id/rows/:rowId
 * Update a database row
 */
router.patch('/:id/rows/:rowId', async (req: Request, res: Response) => {
  try {
    const { id, rowId } = req.params;
    const { properties, position } = req.body;

    // Get row
    const rowResult = await pool.query<DatabaseRow>(
      'SELECT * FROM database_rows WHERE id = $1 AND database_id = $2',
      [rowId, id]
    );

    if (rowResult.rows.length === 0) {
      res.status(404).json({ error: 'Row not found' });
      return;
    }

    // Get database
    const pageResult = await pool.query<Page>(
      'SELECT workspace_id FROM pages WHERE id = $1',
      [id]
    );

    // Check workspace membership
    const memberCheck = await pool.query(
      `SELECT role FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [pageResult.rows[0].workspace_id, req.user!.id]
    );

    if (memberCheck.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this workspace' });
      return;
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (properties !== undefined) {
      // Merge with existing properties
      const currentProperties = rowResult.rows[0].properties as Record<string, unknown>;
      const mergedProperties = { ...currentProperties, ...properties };
      updates.push(`properties = $${paramIndex++}`);
      values.push(JSON.stringify(mergedProperties));
    }

    if (position !== undefined) {
      updates.push(`position = $${paramIndex++}`);
      values.push(position);
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No updates provided' });
      return;
    }

    values.push(rowId);
    const result = await pool.query<DatabaseRow>(
      `UPDATE database_rows SET ${updates.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING *`,
      values
    );

    res.json({ row: result.rows[0] });
  } catch (error) {
    console.error('Update row error:', error);
    res.status(500).json({ error: 'Failed to update row' });
  }
});

/**
 * DELETE /api/databases/:id/rows/:rowId
 * Delete (archive) a database row
 */
router.delete('/:id/rows/:rowId', async (req: Request, res: Response) => {
  try {
    const { id, rowId } = req.params;
    const { permanent } = req.query;

    const rowResult = await pool.query<DatabaseRow>(
      'SELECT * FROM database_rows WHERE id = $1 AND database_id = $2',
      [rowId, id]
    );

    if (rowResult.rows.length === 0) {
      res.status(404).json({ error: 'Row not found' });
      return;
    }

    // Get database
    const pageResult = await pool.query<Page>(
      'SELECT workspace_id FROM pages WHERE id = $1',
      [id]
    );

    // Check workspace membership
    const memberCheck = await pool.query(
      `SELECT role FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [pageResult.rows[0].workspace_id, req.user!.id]
    );

    if (memberCheck.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this workspace' });
      return;
    }

    if (permanent === 'true') {
      await pool.query('DELETE FROM database_rows WHERE id = $1', [rowId]);
      res.json({ message: 'Row permanently deleted' });
    } else {
      await pool.query(
        'UPDATE database_rows SET is_archived = true WHERE id = $1',
        [rowId]
      );
      res.json({ message: 'Row archived' });
    }
  } catch (error) {
    console.error('Delete row error:', error);
    res.status(500).json({ error: 'Failed to delete row' });
  }
});

/**
 * POST /api/databases/:id/views
 * Create a new database view
 */
router.post('/:id/views', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, type, filter, sort, group_by, properties_visibility } = req.body;

    // Get database
    const pageResult = await pool.query<Page>(
      'SELECT * FROM pages WHERE id = $1 AND is_database = true',
      [id]
    );

    if (pageResult.rows.length === 0) {
      res.status(404).json({ error: 'Database not found' });
      return;
    }

    // Check workspace membership
    const memberCheck = await pool.query(
      `SELECT role FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [pageResult.rows[0].workspace_id, req.user!.id]
    );

    if (memberCheck.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this workspace' });
      return;
    }

    // Get position for new view
    const lastView = await pool.query<DatabaseView>(
      `SELECT position FROM database_views
       WHERE page_id = $1
       ORDER BY position DESC LIMIT 1`,
      [id]
    );

    const position = generatePosition(lastView.rows[0]?.position || '', '');

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

    res.status(201).json({ view: result.rows[0] });
  } catch (error) {
    console.error('Create view error:', error);
    res.status(500).json({ error: 'Failed to create view' });
  }
});

/**
 * PATCH /api/databases/:id/views/:viewId
 * Update a database view
 */
router.patch('/:id/views/:viewId', async (req: Request, res: Response) => {
  try {
    const { id, viewId } = req.params;
    const { name, type, filter, sort, group_by, properties_visibility, position } = req.body;

    const viewResult = await pool.query<DatabaseView>(
      'SELECT * FROM database_views WHERE id = $1 AND page_id = $2',
      [viewId, id]
    );

    if (viewResult.rows.length === 0) {
      res.status(404).json({ error: 'View not found' });
      return;
    }

    // Get database
    const pageResult = await pool.query<Page>(
      'SELECT workspace_id FROM pages WHERE id = $1',
      [id]
    );

    // Check workspace membership
    const memberCheck = await pool.query(
      `SELECT role FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [pageResult.rows[0].workspace_id, req.user!.id]
    );

    if (memberCheck.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this workspace' });
      return;
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }
    if (type !== undefined) {
      updates.push(`type = $${paramIndex++}`);
      values.push(type);
    }
    if (filter !== undefined) {
      updates.push(`filter = $${paramIndex++}`);
      values.push(JSON.stringify(filter));
    }
    if (sort !== undefined) {
      updates.push(`sort = $${paramIndex++}`);
      values.push(JSON.stringify(sort));
    }
    if (group_by !== undefined) {
      updates.push(`group_by = $${paramIndex++}`);
      values.push(group_by);
    }
    if (properties_visibility !== undefined) {
      updates.push(`properties_visibility = $${paramIndex++}`);
      values.push(JSON.stringify(properties_visibility));
    }
    if (position !== undefined) {
      updates.push(`position = $${paramIndex++}`);
      values.push(position);
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No updates provided' });
      return;
    }

    values.push(viewId);
    const result = await pool.query<DatabaseView>(
      `UPDATE database_views SET ${updates.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING *`,
      values
    );

    res.json({ view: result.rows[0] });
  } catch (error) {
    console.error('Update view error:', error);
    res.status(500).json({ error: 'Failed to update view' });
  }
});

/**
 * DELETE /api/databases/:id/views/:viewId
 * Delete a database view
 */
router.delete('/:id/views/:viewId', async (req: Request, res: Response) => {
  try {
    const { id, viewId } = req.params;

    // Check if it's the last view
    const viewCount = await pool.query(
      'SELECT COUNT(*) FROM database_views WHERE page_id = $1',
      [id]
    );

    if (parseInt(viewCount.rows[0].count) <= 1) {
      res.status(400).json({ error: 'Cannot delete the last view' });
      return;
    }

    // Get database
    const pageResult = await pool.query<Page>(
      'SELECT workspace_id FROM pages WHERE id = $1',
      [id]
    );

    // Check workspace membership
    const memberCheck = await pool.query(
      `SELECT role FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [pageResult.rows[0].workspace_id, req.user!.id]
    );

    if (memberCheck.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this workspace' });
      return;
    }

    await pool.query('DELETE FROM database_views WHERE id = $1', [viewId]);

    res.json({ message: 'View deleted' });
  } catch (error) {
    console.error('Delete view error:', error);
    res.status(500).json({ error: 'Failed to delete view' });
  }
});

/**
 * PATCH /api/databases/:id/schema
 * Update database properties schema
 */
router.patch('/:id/schema', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { properties_schema } = req.body;

    if (!properties_schema) {
      res.status(400).json({ error: 'properties_schema is required' });
      return;
    }

    // Get database
    const pageResult = await pool.query<Page>(
      'SELECT * FROM pages WHERE id = $1 AND is_database = true',
      [id]
    );

    if (pageResult.rows.length === 0) {
      res.status(404).json({ error: 'Database not found' });
      return;
    }

    // Check workspace membership
    const memberCheck = await pool.query(
      `SELECT role FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [pageResult.rows[0].workspace_id, req.user!.id]
    );

    if (memberCheck.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this workspace' });
      return;
    }

    const result = await pool.query<Page>(
      `UPDATE pages SET properties_schema = $1
       WHERE id = $2
       RETURNING *`,
      [JSON.stringify(properties_schema), id]
    );

    res.json({ database: result.rows[0] });
  } catch (error) {
    console.error('Update schema error:', error);
    res.status(500).json({ error: 'Failed to update schema' });
  }
});

export default router;
