/**
 * @fileoverview Block routes. Every write goes through withPageTransaction
 * (services/pageOperations.ts): the change, its operation-log entry and the
 * page's sequence number commit together, and the operation is broadcast to
 * collaborators after commit. Reads and writes are checked against the page's
 * effective permission (services/permissions.ts).
 */

import { Router, Request, Response } from 'express';
import pool from '../models/db.js';
import { authMiddleware } from '../middleware/auth.js';
import type { Block } from '../types/index.js';
import { publishSearchIndex } from '../shared/queue.js';
import { blockOperationsCounter } from '../shared/metrics.js';
import { isUuid, requirePageAccess } from '../services/permissions.js';
import {
  withPageTransaction,
  createBlock,
  updateBlock,
  deleteBlock,
  moveBlock,
} from '../services/pageOperations.js';
import { HttpError, sendError } from '../utils/httpError.js';

const router = Router();

// Apply authentication to all block routes
router.use(authMiddleware);

/** Maximum operations accepted in one batch request. */
const MAX_BATCH_OPERATIONS = 200;

/**
 * Reads the version a client based its edit on, from `expected_version` in the
 * body or an `If-Match` header (`"3"` or `3`). Undefined means "no check".
 */
function expectedVersion(req: Request): number | undefined {
  const raw = req.body?.expected_version ?? req.headers['if-match'];
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parsed = Number(String(raw).replace(/^W\//, '').replace(/"/g, ''));
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new HttpError(400, 'expected_version must be a non-negative integer');
  }
  return parsed;
}

/** Finds the page a block belongs to; blocks never change pages. */
async function pageIdOfBlock(blockId: unknown): Promise<string> {
  if (!isUuid(blockId)) throw new HttpError(404, 'Block not found');
  const result = await pool.query<{ page_id: string }>('SELECT page_id FROM blocks WHERE id = $1', [blockId]);
  if (result.rows.length === 0) throw new HttpError(404, 'Block not found');
  return result.rows[0].page_id;
}

/** Search indexing is best effort and never delays the response. */
function queueSearchIndex(block: Block, workspaceId: string, type: 'index_block' | 'delete_block'): void {
  void publishSearchIndex({
    type,
    blockId: block.id,
    pageId: block.page_id,
    content: type === 'index_block' ? JSON.stringify(block.content ?? []) : undefined,
    workspaceId,
  });
}

/**
 * GET /api/blocks?page_id=...&parent_block_id=...
 * Lists blocks for a page (view permission), ordered by position.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { page_id, parent_block_id } = req.query;
    if (!(await requirePageAccess(req, res, page_id, 'view'))) return;

    let query = 'SELECT * FROM blocks WHERE page_id = $1';
    const params: unknown[] = [page_id];
    if (parent_block_id !== undefined) {
      if (parent_block_id === 'null' || parent_block_id === '') {
        query += ' AND parent_block_id IS NULL';
      } else if (isUuid(parent_block_id)) {
        query += ' AND parent_block_id = $2';
        params.push(parent_block_id);
      } else {
        res.status(400).json({ error: 'parent_block_id must be a UUID' });
        return;
      }
    }
    query += ' ORDER BY position, id';

    const result = await pool.query<Block>(query, params);
    res.json({ blocks: result.rows });
  } catch (error) {
    sendError(res, error, 'Failed to get blocks');
  }
});

/**
 * POST /api/blocks
 * Creates a block (edit permission). The client may send its own `id`; a retry
 * with the same id returns the existing block with 200 instead of a duplicate.
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const access = await requirePageAccess(req, res, req.body?.page_id, 'edit');
    if (!access) return;

    const { result, ops } = await withPageTransaction(access.page.id, req.user!.id, (tx) =>
      createBlock(tx, req.body)
    );
    if (!result.replayed) queueSearchIndex(result.block, access.page.workspace_id, 'index_block');

    res.status(result.replayed ? 200 : 201).json({ block: result.block, seq: ops.at(-1)?.seq });
  } catch (error) {
    blockOperationsCounter.inc({ type: 'insert', status: 'failure' });
    sendError(res, error, 'Failed to create block');
  }
});

/**
 * PATCH /api/blocks/:id
 * Updates type, content, properties or is_collapsed (edit permission).
 * Send `expected_version` (or If-Match) to get a 409 with the current block
 * instead of overwriting someone else's newer change.
 */
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    if (req.body?.parent_block_id !== undefined || req.body?.position !== undefined) {
      res.status(400).json({ error: 'Use POST /api/blocks/:id/move to change parent or position' });
      return;
    }
    const pageId = await pageIdOfBlock(req.params.id);
    const access = await requirePageAccess(req, res, pageId, 'edit');
    if (!access) return;

    const version = expectedVersion(req);
    const { type, properties, content, is_collapsed } = req.body ?? {};
    const { result: block, ops } = await withPageTransaction(pageId, req.user!.id, (tx) =>
      updateBlock(tx, req.params.id, { type, properties, content, is_collapsed }, version)
    );
    if (content !== undefined) queueSearchIndex(block, access.page.workspace_id, 'index_block');

    res.json({ block, seq: ops.at(-1)?.seq });
  } catch (error) {
    blockOperationsCounter.inc({ type: 'update', status: 'failure' });
    sendError(res, error, 'Failed to update block');
  }
});

/**
 * DELETE /api/blocks/:id
 * Deletes a block and its children (edit permission).
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const pageId = await pageIdOfBlock(req.params.id);
    const access = await requirePageAccess(req, res, pageId, 'edit');
    if (!access) return;

    const version = expectedVersion(req);
    const { result: block, ops } = await withPageTransaction(pageId, req.user!.id, (tx) =>
      deleteBlock(tx, req.params.id, version)
    );
    queueSearchIndex(block, access.page.workspace_id, 'delete_block');

    res.json({ message: 'Block deleted', seq: ops.at(-1)?.seq });
  } catch (error) {
    blockOperationsCounter.inc({ type: 'delete', status: 'failure' });
    sendError(res, error, 'Failed to delete block');
  }
});

/**
 * POST /api/blocks/:id/move
 * Moves a block after a sibling (`after_block_id`) or to the end of a parent's
 * children (`parent_block_id`, null for the page root). Omitting both moves it
 * to the end of its current parent.
 */
router.post('/:id/move', async (req: Request, res: Response) => {
  try {
    const pageId = await pageIdOfBlock(req.params.id);
    const access = await requirePageAccess(req, res, pageId, 'edit');
    if (!access) return;

    const version = expectedVersion(req);
    const { parent_block_id, after_block_id } = req.body ?? {};
    const { result: block, ops } = await withPageTransaction(pageId, req.user!.id, (tx) =>
      moveBlock(tx, req.params.id, { parent_block_id, after_block_id }, version)
    );

    res.json({ block, seq: ops.at(-1)?.seq });
  } catch (error) {
    blockOperationsCounter.inc({ type: 'move', status: 'failure' });
    sendError(res, error, 'Failed to move block');
  }
});

/**
 * POST /api/blocks/batch
 * Applies several operations to ONE page atomically: all of them commit with
 * consecutive seqs, or none do. Every block id is resolved within `page_id`,
 * so a batch cannot touch blocks on other pages.
 *
 * Operation shapes:
 *   { type: 'insert', id?, block_type?, parent_block_id?, after_block_id?, content?, properties? }
 *   { type: 'update', id, block_type?, content?, properties?, is_collapsed?, expected_version? }
 *   { type: 'move',   id, parent_block_id?, after_block_id?, expected_version? }
 *   { type: 'delete', id, expected_version? }
 */
router.post('/batch', async (req: Request, res: Response) => {
  try {
    const { page_id, operations } = req.body ?? {};
    if (!Array.isArray(operations) || operations.length === 0) {
      res.status(400).json({ error: 'page_id and a non-empty operations array are required' });
      return;
    }
    if (operations.length > MAX_BATCH_OPERATIONS) {
      res.status(400).json({ error: `At most ${MAX_BATCH_OPERATIONS} operations per batch` });
      return;
    }
    const access = await requirePageAccess(req, res, page_id, 'edit');
    if (!access) return;

    const { result: blocks, ops } = await withPageTransaction(access.page.id, req.user!.id, async (tx) => {
      const changed: Block[] = [];
      for (const op of operations) {
        const version = op.expected_version === undefined ? undefined : Number(op.expected_version);
        switch (op?.type) {
          case 'insert':
            changed.push((await createBlock(tx, { ...op, type: op.block_type })).block);
            break;
          case 'update':
            changed.push(
              await updateBlock(
                tx,
                op.id,
                { type: op.block_type, content: op.content, properties: op.properties, is_collapsed: op.is_collapsed },
                version
              )
            );
            break;
          case 'move':
            changed.push(await moveBlock(tx, op.id, op, version));
            break;
          case 'delete':
            await deleteBlock(tx, op.id, version);
            break;
          default:
            throw new HttpError(400, `Unknown operation type "${String(op?.type)}"`);
        }
      }
      return changed;
    });

    res.json({ blocks, seq: ops.at(-1)?.seq });
  } catch (error) {
    sendError(res, error, 'Failed to process batch operations');
  }
});

export default router;
