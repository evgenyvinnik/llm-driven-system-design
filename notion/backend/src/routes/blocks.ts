/**
 * @fileoverview Block management routes for the content editing system.
 * Blocks are the fundamental content units that compose pages. This module
 * handles CRUD operations and logs operations for real-time sync via CRDT.
 */

import { Router, Request, Response } from 'express';
import pool from '../models/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { generatePosition } from '../utils/fractionalIndex.js';
import { generateHLC, hlcToNumber } from '../utils/hlc.js';
import type { Block, Page } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';
import { invalidatePageCache } from '../shared/cache.js';
import { blockOperationsCounter } from '../shared/metrics.js';
import { publishSearchIndex } from '../shared/queue.js';

const router = Router();

// Apply authentication to all block routes
router.use(authMiddleware);

/**
 * GET /api/blocks
 * Lists blocks for a page, optionally filtered by parent_block_id.
 * Returns blocks ordered by their fractional index position.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { page_id, parent_block_id } = req.query;

    if (!page_id) {
      res.status(400).json({ error: 'page_id is required' });
      return;
    }

    // Check page access
    const pageResult = await pool.query<Page>(
      'SELECT workspace_id FROM pages WHERE id = $1',
      [page_id]
    );

    if (pageResult.rows.length === 0) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    const memberCheck = await pool.query(
      `SELECT role FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [pageResult.rows[0].workspace_id, req.user!.id]
    );

    if (memberCheck.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this workspace' });
      return;
    }

    let query = `SELECT * FROM blocks WHERE page_id = $1`;
    const params: unknown[] = [page_id];

    if (parent_block_id !== undefined) {
      if (parent_block_id === 'null' || parent_block_id === '') {
        query += ` AND parent_block_id IS NULL`;
      } else {
        query += ` AND parent_block_id = $2`;
        params.push(parent_block_id);
      }
    }

    query += ` ORDER BY position`;

    const result = await pool.query<Block>(query, params);

    res.json({ blocks: result.rows });
  } catch (error) {
    console.error('Get blocks error:', error);
    res.status(500).json({ error: 'Failed to get blocks' });
  }
});

/**
 * POST /api/blocks
 * Creates a new block within a page.
 * Uses fractional indexing and logs the operation for real-time sync.
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      page_id,
      parent_block_id,
      type,
      properties,
      content,
      after_block_id,
    } = req.body;

    if (!page_id) {
      res.status(400).json({ error: 'page_id is required' });
      return;
    }

    // Check page access
    const pageResult = await pool.query<Page>(
      'SELECT workspace_id FROM pages WHERE id = $1',
      [page_id]
    );

    if (pageResult.rows.length === 0) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    const memberCheck = await pool.query(
      `SELECT role FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [pageResult.rows[0].workspace_id, req.user!.id]
    );

    if (memberCheck.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this workspace' });
      return;
    }

    // Calculate position
    let position = 'n';
    if (after_block_id) {
      const afterBlock = await pool.query<Block>(
        'SELECT position FROM blocks WHERE id = $1',
        [after_block_id]
      );

      if (afterBlock.rows.length > 0) {
        const nextSibling = await pool.query<Block>(
          `SELECT position FROM blocks
           WHERE page_id = $1 AND parent_block_id ${parent_block_id ? '= $2' : 'IS NULL'}
           AND position > $${parent_block_id ? 3 : 2}
           ORDER BY position LIMIT 1`,
          parent_block_id
            ? [page_id, parent_block_id, afterBlock.rows[0].position]
            : [page_id, afterBlock.rows[0].position]
        );

        position = generatePosition(
          afterBlock.rows[0].position,
          nextSibling.rows[0]?.position || ''
        );
      }
    } else {
      const lastBlock = await pool.query<Block>(
        `SELECT position FROM blocks
         WHERE page_id = $1 AND parent_block_id ${parent_block_id ? '= $2' : 'IS NULL'}
         ORDER BY position DESC LIMIT 1`,
        parent_block_id ? [page_id, parent_block_id] : [page_id]
      );

      position = generatePosition(lastBlock.rows[0]?.position || '', '');
    }

    const blockId = uuidv4();
    const result = await pool.query<Block>(
      `INSERT INTO blocks (id, page_id, parent_block_id, type, properties, content, position, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        blockId,
        page_id,
        parent_block_id || null,
        type || 'text',
        JSON.stringify(properties || {}),
        JSON.stringify(content || []),
        position,
        req.user!.id,
      ]
    );

    const block = result.rows[0];

    // Log operation for sync
    const hlc = generateHLC();
    await pool.query(
      `INSERT INTO operations (page_id, block_id, type, data, timestamp, author_id)
       VALUES ($1, $2, 'insert', $3, $4, $5)`,
      [page_id, blockId, JSON.stringify(block), hlcToNumber(hlc), req.user!.id]
    );

    // Invalidate page cache on block insert
    await invalidatePageCache(page_id);

    // Track metrics
    blockOperationsCounter.inc({ type: 'insert', status: 'success' });

    // Queue search index update
    await publishSearchIndex({
      type: 'index_block',
      blockId: blockId,
      pageId: page_id,
      content: JSON.stringify(content || []),
      workspaceId: pageResult.rows[0].workspace_id,
    });

    res.status(201).json({ block });
  } catch (error) {
    console.error('Create block error:', error);
    res.status(500).json({ error: 'Failed to create block' });
  }
});

/**
 * PATCH /api/blocks/:id
 * Updates block properties, content, type, or position.
 * Increments version number and logs operation for sync.
 */
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { type, properties, content, position, parent_block_id, is_collapsed } = req.body;

    const blockResult = await pool.query<Block>(
      'SELECT * FROM blocks WHERE id = $1',
      [id]
    );

    if (blockResult.rows.length === 0) {
      res.status(404).json({ error: 'Block not found' });
      return;
    }

    const block = blockResult.rows[0];

    // Check page access
    const pageResult = await pool.query<Page>(
      'SELECT workspace_id FROM pages WHERE id = $1',
      [block.page_id]
    );

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

    if (type !== undefined) {
      updates.push(`type = $${paramIndex++}`);
      values.push(type);
    }
    if (properties !== undefined) {
      updates.push(`properties = $${paramIndex++}`);
      values.push(JSON.stringify(properties));
    }
    if (content !== undefined) {
      updates.push(`content = $${paramIndex++}`);
      values.push(JSON.stringify(content));
    }
    if (position !== undefined) {
      updates.push(`position = $${paramIndex++}`);
      values.push(position);
    }
    if (parent_block_id !== undefined) {
      updates.push(`parent_block_id = $${paramIndex++}`);
      values.push(parent_block_id || null);
    }
    if (is_collapsed !== undefined) {
      updates.push(`is_collapsed = $${paramIndex++}`);
      values.push(is_collapsed);
    }

    // Always increment version
    updates.push(`version = version + 1`);

    if (updates.length === 1) {
      // Only version update, no actual changes
      res.status(400).json({ error: 'No updates provided' });
      return;
    }

    values.push(id);
    const result = await pool.query<Block>(
      `UPDATE blocks SET ${updates.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING *`,
      values
    );

    const updatedBlock = result.rows[0];

    // Log operation for sync
    const hlc = generateHLC();
    await pool.query(
      `INSERT INTO operations (page_id, block_id, type, data, timestamp, author_id)
       VALUES ($1, $2, 'update', $3, $4, $5)`,
      [
        block.page_id,
        id,
        JSON.stringify({ before: block, after: updatedBlock }),
        hlcToNumber(hlc),
        req.user!.id,
      ]
    );

    // Invalidate page cache on block update
    await invalidatePageCache(block.page_id);

    // Track metrics
    blockOperationsCounter.inc({ type: 'update', status: 'success' });

    // Queue search index update if content changed
    if (content !== undefined) {
      await publishSearchIndex({
        type: 'index_block',
        blockId: id as string,
        pageId: block.page_id,
        content: JSON.stringify(content),
        workspaceId: pageResult.rows[0].workspace_id,
      });
    }

    res.json({ block: updatedBlock });
  } catch (error) {
    console.error('Update block error:', error);
    res.status(500).json({ error: 'Failed to update block' });
  }
});

/**
 * DELETE /api/blocks/:id
 * Deletes a block and all its child blocks (via cascade).
 * Logs the deletion operation for real-time sync.
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const blockResult = await pool.query<Block>(
      'SELECT * FROM blocks WHERE id = $1',
      [id]
    );

    if (blockResult.rows.length === 0) {
      res.status(404).json({ error: 'Block not found' });
      return;
    }

    const block = blockResult.rows[0];

    // Check page access
    const pageResult = await pool.query<Page>(
      'SELECT workspace_id FROM pages WHERE id = $1',
      [block.page_id]
    );

    const memberCheck = await pool.query(
      `SELECT role FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [pageResult.rows[0].workspace_id, req.user!.id]
    );

    if (memberCheck.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this workspace' });
      return;
    }

    // Delete block (cascade will delete children)
    await pool.query('DELETE FROM blocks WHERE id = $1', [id]);

    // Log operation for sync
    const hlc = generateHLC();
    await pool.query(
      `INSERT INTO operations (page_id, block_id, type, data, timestamp, author_id)
       VALUES ($1, $2, 'delete', $3, $4, $5)`,
      [block.page_id, id, JSON.stringify(block), hlcToNumber(hlc), req.user!.id]
    );

    // Invalidate page cache on block delete
    await invalidatePageCache(block.page_id);

    // Track metrics
    blockOperationsCounter.inc({ type: 'delete', status: 'success' });

    // Queue search index deletion
    await publishSearchIndex({
      type: 'delete_block',
      blockId: id as string,
      pageId: block.page_id,
      workspaceId: pageResult.rows[0].workspace_id,
    });

    res.json({ message: 'Block deleted' });
  } catch (error) {
    console.error('Delete block error:', error);
    res.status(500).json({ error: 'Failed to delete block' });
  }
});

/**
 * POST /api/blocks/:id/move
 * Moves a block to a new position within or between parent blocks.
 * Recalculates fractional index position and logs the move operation.
 */
router.post('/:id/move', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { parent_block_id, after_block_id } = req.body;

    const blockResult = await pool.query<Block>(
      'SELECT * FROM blocks WHERE id = $1',
      [id]
    );

    if (blockResult.rows.length === 0) {
      res.status(404).json({ error: 'Block not found' });
      return;
    }

    const block = blockResult.rows[0];

    // Check page access
    const pageResult = await pool.query<Page>(
      'SELECT workspace_id FROM pages WHERE id = $1',
      [block.page_id]
    );

    const memberCheck = await pool.query(
      `SELECT role FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [pageResult.rows[0].workspace_id, req.user!.id]
    );

    if (memberCheck.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this workspace' });
      return;
    }

    // Calculate new position
    let position = 'n';
    if (after_block_id) {
      const afterBlock = await pool.query<Block>(
        'SELECT position FROM blocks WHERE id = $1',
        [after_block_id]
      );

      if (afterBlock.rows.length > 0) {
        const nextSibling = await pool.query<Block>(
          `SELECT position FROM blocks
           WHERE page_id = $1 AND parent_block_id ${parent_block_id ? '= $2' : 'IS NULL'}
           AND position > $${parent_block_id ? 3 : 2}
           AND id != $${parent_block_id ? 4 : 3}
           ORDER BY position LIMIT 1`,
          parent_block_id
            ? [block.page_id, parent_block_id, afterBlock.rows[0].position, id]
            : [block.page_id, afterBlock.rows[0].position, id]
        );

        position = generatePosition(
          afterBlock.rows[0].position,
          nextSibling.rows[0]?.position || ''
        );
      }
    } else {
      const lastBlock = await pool.query<Block>(
        `SELECT position FROM blocks
         WHERE page_id = $1 AND parent_block_id ${parent_block_id ? '= $2' : 'IS NULL'}
         AND id != $${parent_block_id ? 3 : 2}
         ORDER BY position DESC LIMIT 1`,
        parent_block_id ? [block.page_id, parent_block_id, id] : [block.page_id, id]
      );

      position = generatePosition(lastBlock.rows[0]?.position || '', '');
    }

    const result = await pool.query<Block>(
      `UPDATE blocks SET parent_block_id = $1, position = $2, version = version + 1
       WHERE id = $3
       RETURNING *`,
      [parent_block_id || null, position, id]
    );

    // Log operation for sync
    const hlc = generateHLC();
    await pool.query(
      `INSERT INTO operations (page_id, block_id, type, data, timestamp, author_id)
       VALUES ($1, $2, 'move', $3, $4, $5)`,
      [
        block.page_id,
        id,
        JSON.stringify({
          from: { parent: block.parent_block_id, position: block.position },
          to: { parent: parent_block_id || null, position },
        }),
        hlcToNumber(hlc),
        req.user!.id,
      ]
    );

    res.json({ block: result.rows[0] });
  } catch (error) {
    console.error('Move block error:', error);
    res.status(500).json({ error: 'Failed to move block' });
  }
});

/**
 * POST /api/blocks/batch
 * Processes multiple block operations (insert, update, delete) atomically.
 * Uses a database transaction to ensure all-or-nothing execution.
 */
router.post('/batch', async (req: Request, res: Response) => {
  try {
    const { page_id, operations } = req.body;

    if (!page_id || !operations || !Array.isArray(operations)) {
      res.status(400).json({ error: 'page_id and operations array are required' });
      return;
    }

    // Check page access
    const pageResult = await pool.query<Page>(
      'SELECT workspace_id FROM pages WHERE id = $1',
      [page_id]
    );

    if (pageResult.rows.length === 0) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    const memberCheck = await pool.query(
      `SELECT role FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [pageResult.rows[0].workspace_id, req.user!.id]
    );

    if (memberCheck.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this workspace' });
      return;
    }

    const results: Block[] = [];
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      for (const op of operations) {
        const hlc = generateHLC();

        if (op.type === 'insert') {
          const blockId = op.id || uuidv4();
          const result = await client.query<Block>(
            `INSERT INTO blocks (id, page_id, parent_block_id, type, properties, content, position, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [
              blockId,
              page_id,
              op.parent_block_id || null,
              op.block_type || 'text',
              JSON.stringify(op.properties || {}),
              JSON.stringify(op.content || []),
              op.position || 'n',
              req.user!.id,
            ]
          );
          results.push(result.rows[0]);

          await client.query(
            `INSERT INTO operations (page_id, block_id, type, data, timestamp, author_id)
             VALUES ($1, $2, 'insert', $3, $4, $5)`,
            [page_id, blockId, JSON.stringify(result.rows[0]), hlcToNumber(hlc), req.user!.id]
          );
        } else if (op.type === 'update' && op.id) {
          const updates: string[] = [];
          const values: unknown[] = [];
          let paramIndex = 1;

          if (op.block_type !== undefined) {
            updates.push(`type = $${paramIndex++}`);
            values.push(op.block_type);
          }
          if (op.properties !== undefined) {
            updates.push(`properties = $${paramIndex++}`);
            values.push(JSON.stringify(op.properties));
          }
          if (op.content !== undefined) {
            updates.push(`content = $${paramIndex++}`);
            values.push(JSON.stringify(op.content));
          }
          if (op.position !== undefined) {
            updates.push(`position = $${paramIndex++}`);
            values.push(op.position);
          }

          updates.push(`version = version + 1`);
          values.push(op.id);

          const result = await client.query<Block>(
            `UPDATE blocks SET ${updates.join(', ')}
             WHERE id = $${paramIndex}
             RETURNING *`,
            values
          );

          if (result.rows.length > 0) {
            results.push(result.rows[0]);

            await client.query(
              `INSERT INTO operations (page_id, block_id, type, data, timestamp, author_id)
               VALUES ($1, $2, 'update', $3, $4, $5)`,
              [page_id, op.id, JSON.stringify(result.rows[0]), hlcToNumber(hlc), req.user!.id]
            );
          }
        } else if (op.type === 'delete' && op.id) {
          await client.query('DELETE FROM blocks WHERE id = $1', [op.id]);

          await client.query(
            `INSERT INTO operations (page_id, block_id, type, data, timestamp, author_id)
             VALUES ($1, $2, 'delete', $3, $4, $5)`,
            [page_id, op.id, JSON.stringify({ id: op.id }), hlcToNumber(hlc), req.user!.id]
          );
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    res.json({ blocks: results });
  } catch (error) {
    console.error('Batch operation error:', error);
    res.status(500).json({ error: 'Failed to process batch operations' });
  }
});

export default router;
