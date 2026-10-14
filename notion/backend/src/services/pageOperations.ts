/**
 * @fileoverview The block write path. Every block change is applied, logged and
 * sequenced in ONE PostgreSQL transaction, then broadcast after commit:
 *
 *  1. Lock the page row (`SELECT ... FOR NO KEY UPDATE`). Writers to the same
 *     page are serialized, so "read the neighbors, pick a position between them,
 *     insert" is atomic and every operation on the page gets a total order.
 *  2. Apply the change to `blocks`. Updates may carry the version the client
 *     based its edit on; a mismatch is a 409 with the current block, so a stale
 *     client cannot silently overwrite a newer version (compare-and-swap).
 *  3. Append the change to `operations` with seq = pages.last_op_seq + 1. The
 *     counter is updated in the same transaction, so a rolled-back write leaves
 *     no hole. (A PostgreSQL SEQUENCE is not transactional and would leave gaps
 *     that clients would mistake for lost messages.)
 *  4. After COMMIT, invalidate the page cache and publish each operation on the
 *     page's Redis channel. If a publish is lost, clients see a seq gap and
 *     replay from the log with readOperationsSince().
 */

import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import pool from '../models/db.js';
import { generateHLC, encodeHLC } from '../utils/hlc.js';
import {
  generateKeyBetween,
  generateNKeysBetween,
  isPositionTooLong,
  PositionError,
} from '../utils/fractionalIndex.js';
import { HttpError } from '../utils/httpError.js';
import type { Block, DatabaseView, Page } from '../types/index.js';
import { isUuid } from './permissions.js';
import { publishPageEvent } from './realtime.js';
import { invalidatePageCache } from '../shared/cache.js';
import { blockOperationsCounter } from '../shared/metrics.js';
import { logger } from '../shared/logger.js';

export type BlockOperationType = 'insert' | 'update' | 'delete' | 'move';

/** Block types the editor understands. */
export const BLOCK_TYPES = [
  'text', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list', 'numbered_list',
  'toggle', 'code', 'quote', 'callout', 'divider', 'image', 'video', 'embed',
  'table', 'database',
] as const;

/** A committed, sequenced block operation in the form sent to clients. */
export interface PageOperation {
  op_id: string;
  page_id: string;
  seq: number;
  block_id: string;
  type: BlockOperationType;
  /** The block row after the change; null for a delete. */
  block: Block | null;
  author_id: string | null;
  /** Packed hybrid logical clock (see utils/hlc.ts), as a decimal string. */
  timestamp: string;
  created_at: string;
}

/** A transaction holding the page lock; operations appended here share one commit. */
export class PageTransaction {
  readonly ops: PageOperation[] = [];

  constructor(
    readonly client: PoolClient,
    readonly pageId: string,
    readonly authorId: string,
    private seq: number
  ) {}

  /** The highest seq assigned so far in this transaction. */
  get currentSeq(): number {
    return this.seq;
  }

  /** Records a change in the operation log with the next seq for the page. */
  async append(
    type: BlockOperationType,
    blockId: string,
    block: Block | null,
    data: Record<string, unknown>
  ): Promise<PageOperation> {
    this.seq += 1;
    const opId = uuidv4();
    const timestamp = encodeHLC(generateHLC());
    const result = await this.client.query<{ created_at: Date }>(
      `INSERT INTO operations (id, page_id, seq, block_id, type, data, timestamp, author_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING created_at`,
      [opId, this.pageId, this.seq, blockId, type, JSON.stringify(data), timestamp, this.authorId]
    );
    const op: PageOperation = {
      op_id: opId,
      page_id: this.pageId,
      seq: this.seq,
      block_id: blockId,
      type,
      block,
      author_id: this.authorId,
      timestamp,
      created_at: new Date(result.rows[0].created_at).toISOString(),
    };
    this.ops.push(op);
    return op;
  }
}

/**
 * Runs `fn` inside a transaction that holds the page lock, then commits the
 * page's new seq, invalidates the page cache and publishes the operations.
 */
export async function withPageTransaction<T>(
  pageId: string,
  authorId: string,
  fn: (tx: PageTransaction) => Promise<T>
): Promise<{ result: T; ops: PageOperation[] }> {
  const client = await pool.connect();
  let result: T;
  let ops: PageOperation[];

  try {
    await client.query('BEGIN');
    const locked = await client.query<{ last_op_seq: string }>(
      'SELECT last_op_seq FROM pages WHERE id = $1 FOR NO KEY UPDATE',
      [pageId]
    );
    if (locked.rows.length === 0) {
      throw new HttpError(404, 'Page not found');
    }

    const tx = new PageTransaction(client, pageId, authorId, Number(locked.rows[0].last_op_seq));
    result = await fn(tx);
    if (tx.ops.length > 0) {
      await client.query('UPDATE pages SET last_op_seq = $2 WHERE id = $1', [pageId, tx.currentSeq]);
    }
    await client.query('COMMIT');
    ops = tx.ops;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  if (ops.length > 0) {
    await invalidatePageCache(pageId);
    for (const op of ops) {
      blockOperationsCounter.inc({ type: op.type, status: 'success' });
      await publishPageEvent({ type: 'operation', pageId, payload: op });
    }
  }
  return { result, ops };
}

// ---------------------------------------------------------------------------
// Block lookups (all scoped to the locked page)
// ---------------------------------------------------------------------------

async function findBlockInPage(tx: PageTransaction, blockId: unknown): Promise<Block | null> {
  if (!isUuid(blockId)) return null;
  const result = await tx.client.query<Block>(
    'SELECT * FROM blocks WHERE id = $1 AND page_id = $2',
    [blockId, tx.pageId]
  );
  return result.rows[0] ?? null;
}

async function lockBlock(tx: PageTransaction, blockId: unknown): Promise<Block> {
  if (!isUuid(blockId)) throw new HttpError(404, 'Block not found');
  const result = await tx.client.query<Block>(
    'SELECT * FROM blocks WHERE id = $1 AND page_id = $2 FOR UPDATE',
    [blockId, tx.pageId]
  );
  if (result.rows.length === 0) throw new HttpError(404, 'Block not found');
  return result.rows[0];
}

/** True when `candidateId` is `rootId` or nested anywhere under it. */
async function isBlockInSubtree(tx: PageTransaction, rootId: string, candidateId: string): Promise<boolean> {
  const result = await tx.client.query(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_block_id, 0 AS depth FROM blocks WHERE id = $1
       UNION ALL
       SELECT b.id, b.parent_block_id, c.depth + 1
       FROM blocks b JOIN chain c ON b.id = c.parent_block_id
       WHERE c.depth < 100
     )
     SELECT 1 FROM chain WHERE id = $2 LIMIT 1`,
    [candidateId, rootId]
  );
  return result.rows.length > 0;
}

function assertExpectedVersion(block: Block, expectedVersion: number | undefined): void {
  if (expectedVersion !== undefined && block.version !== expectedVersion) {
    throw new HttpError(409, 'The block was changed by someone else', { block });
  }
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

interface Sibling {
  id: string;
  position: string;
}

async function loadSiblings(
  tx: PageTransaction,
  parentId: string | null,
  excludeId: string | null
): Promise<Sibling[]> {
  const result = await tx.client.query<Sibling>(
    `SELECT id, position FROM blocks
     WHERE page_id = $1 AND parent_block_id IS NOT DISTINCT FROM $2
       AND ($3::uuid IS NULL OR id <> $3::uuid)
     ORDER BY position, id`,
    [tx.pageId, parentId, excludeId]
  );
  return result.rows;
}

/**
 * Rewrites the positions of a sibling list as evenly spread keys and logs each
 * change as a `move`, so clients holding the old keys converge.
 */
async function rebalanceSiblings(tx: PageTransaction, siblings: Sibling[]): Promise<Sibling[]> {
  const keys = generateNKeysBetween(null, null, siblings.length);
  const result = await tx.client.query<Block>(
    `UPDATE blocks b SET position = v.position, version = b.version + 1
     FROM unnest($1::uuid[], $2::text[]) AS v(id, position)
     WHERE b.id = v.id AND b.page_id = $3
     RETURNING b.*`,
    [siblings.map((s) => s.id), keys, tx.pageId]
  );
  const byId = new Map(result.rows.map((block) => [block.id, block]));
  for (const sibling of siblings) {
    const block = byId.get(sibling.id);
    if (block) await tx.append('move', block.id, block, { block, reason: 'rebalance' });
  }
  logger.info({ pageId: tx.pageId, count: siblings.length }, 'Rebalanced block positions');
  return siblings.map((sibling, index) => ({ id: sibling.id, position: keys[index] }));
}

/**
 * Position for a block placed right after `afterId` among the children of
 * `parentId` (at the end when afterId is null). Runs under the page lock, so two
 * concurrent inserts into the same gap can never receive the same key. When the
 * gap has no room (duplicate or legacy keys) or keys grew too long, the sibling
 * list is rebalanced first.
 */
async function computePosition(
  tx: PageTransaction,
  parentId: string | null,
  afterId: string | null,
  movingId: string | null
): Promise<string> {
  let siblings = await loadSiblings(tx, parentId, movingId);
  const index = afterId === null ? siblings.length - 1 : siblings.findIndex((s) => s.id === afterId);
  if (afterId !== null && index === -1) {
    throw new HttpError(400, 'after_block_id must be a sibling of the new position');
  }

  const between = (list: Sibling[]) =>
    generateKeyBetween(index >= 0 ? list[index].position : null, list[index + 1]?.position ?? null);

  try {
    const key = between(siblings);
    if (!isPositionTooLong(key)) return key;
  } catch (error) {
    if (!(error instanceof PositionError)) throw error;
  }

  siblings = await rebalanceSiblings(tx, siblings);
  return between(siblings);
}

// ---------------------------------------------------------------------------
// Block operations
// ---------------------------------------------------------------------------

export interface CreateBlockInput {
  id?: unknown;
  parent_block_id?: unknown;
  after_block_id?: unknown;
  type?: unknown;
  properties?: unknown;
  content?: unknown;
}

export interface BlockPatch {
  type?: unknown;
  properties?: unknown;
  content?: unknown;
  is_collapsed?: unknown;
}

function assertBlockType(type: unknown): asserts type is string {
  if (typeof type !== 'string' || !(BLOCK_TYPES as readonly string[]).includes(type)) {
    throw new HttpError(400, `Unknown block type "${String(type)}"`);
  }
}

/**
 * Creates a block. The client may choose the id (a UUID): retrying the same
 * create returns the existing block instead of inserting a duplicate, which
 * makes block creation safe to retry after a timeout.
 */
export async function createBlock(
  tx: PageTransaction,
  input: CreateBlockInput
): Promise<{ block: Block; replayed: boolean }> {
  if (input.id !== undefined && input.id !== null && !isUuid(input.id)) {
    throw new HttpError(400, 'id must be a UUID');
  }
  if (isUuid(input.id)) {
    const existing = await tx.client.query<Block>('SELECT * FROM blocks WHERE id = $1', [input.id]);
    if (existing.rows.length > 0) {
      if (existing.rows[0].page_id !== tx.pageId) {
        throw new HttpError(409, 'A block with this id already exists');
      }
      return { block: existing.rows[0], replayed: true };
    }
  }

  const type = input.type ?? 'text';
  assertBlockType(type);

  // "Insert after X" makes the new block X's next sibling, whatever parent was sent.
  let parentId: string | null = null;
  let afterId: string | null = null;
  if (input.after_block_id) {
    const after = await findBlockInPage(tx, input.after_block_id);
    if (!after) throw new HttpError(400, 'after_block_id is not a block on this page');
    parentId = after.parent_block_id;
    afterId = after.id;
  } else if (input.parent_block_id) {
    const parent = await findBlockInPage(tx, input.parent_block_id);
    if (!parent) throw new HttpError(400, 'parent_block_id is not a block on this page');
    parentId = parent.id;
  }

  const position = await computePosition(tx, parentId, afterId, null);
  const result = await tx.client.query<Block>(
    `INSERT INTO blocks (id, page_id, parent_block_id, type, properties, content, position, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      isUuid(input.id) ? input.id : uuidv4(),
      tx.pageId,
      parentId,
      type,
      JSON.stringify(input.properties ?? {}),
      JSON.stringify(input.content ?? []),
      position,
      tx.authorId,
    ]
  );

  const block = result.rows[0];
  await tx.append('insert', block.id, block, { block });
  return { block, replayed: false };
}

/**
 * Updates content fields of a block. `expectedVersion` is the version the
 * client's edit is based on; a mismatch is a 409 carrying the current block.
 */
export async function updateBlock(
  tx: PageTransaction,
  blockId: unknown,
  patch: BlockPatch,
  expectedVersion?: number
): Promise<Block> {
  const current = await lockBlock(tx, blockId);
  assertExpectedVersion(current, expectedVersion);

  const updates: string[] = [];
  const values: unknown[] = [];
  const push = (column: string, value: unknown) => {
    values.push(value);
    updates.push(`${column} = $${values.length}`);
  };

  if (patch.type !== undefined) {
    assertBlockType(patch.type);
    push('type', patch.type);
  }
  if (patch.properties !== undefined) push('properties', JSON.stringify(patch.properties));
  if (patch.content !== undefined) push('content', JSON.stringify(patch.content));
  if (patch.is_collapsed !== undefined) push('is_collapsed', Boolean(patch.is_collapsed));

  if (updates.length === 0) {
    throw new HttpError(400, 'No updates provided');
  }

  values.push(current.id);
  const result = await tx.client.query<Block>(
    `UPDATE blocks SET ${updates.join(', ')}, version = version + 1
     WHERE id = $${values.length}
     RETURNING *`,
    values
  );

  const block = result.rows[0];
  await tx.append('update', block.id, block, {
    block,
    changed: Object.keys(patch).filter((key) => patch[key as keyof BlockPatch] !== undefined),
  });
  return block;
}

/** Deletes a block; its children go with it through ON DELETE CASCADE. */
export async function deleteBlock(
  tx: PageTransaction,
  blockId: unknown,
  expectedVersion?: number
): Promise<Block> {
  const current = await lockBlock(tx, blockId);
  assertExpectedVersion(current, expectedVersion);
  await tx.client.query('DELETE FROM blocks WHERE id = $1', [current.id]);
  await tx.append('delete', current.id, null, { block: current });
  return current;
}

/**
 * Moves a block after a sibling (or to the end of `parentBlockId`'s children).
 * Rejects parents on other pages and moves into the block's own subtree.
 */
export async function moveBlock(
  tx: PageTransaction,
  blockId: unknown,
  target: { parent_block_id?: unknown; after_block_id?: unknown },
  expectedVersion?: number
): Promise<Block> {
  const current = await lockBlock(tx, blockId);
  assertExpectedVersion(current, expectedVersion);

  let parentId: string | null =
    target.parent_block_id === undefined ? current.parent_block_id : null;
  let afterId: string | null = null;

  if (target.after_block_id) {
    const after = await findBlockInPage(tx, target.after_block_id);
    if (!after || after.id === current.id) {
      throw new HttpError(400, 'after_block_id must be another block on this page');
    }
    parentId = after.parent_block_id;
    afterId = after.id;
  } else if (target.parent_block_id) {
    const parent = await findBlockInPage(tx, target.parent_block_id);
    if (!parent) throw new HttpError(400, 'parent_block_id is not a block on this page');
    parentId = parent.id;
  }

  if (parentId && (await isBlockInSubtree(tx, current.id, parentId))) {
    throw new HttpError(400, 'A block cannot be moved inside itself');
  }

  const position = await computePosition(tx, parentId, afterId, current.id);
  const result = await tx.client.query<Block>(
    `UPDATE blocks SET parent_block_id = $2, position = $3, version = version + 1
     WHERE id = $1
     RETURNING *`,
    [current.id, parentId, position]
  );

  const block = result.rows[0];
  await tx.append('move', block.id, block, {
    block,
    from: { parent: current.parent_block_id, position: current.position },
  });
  return block;
}

// ---------------------------------------------------------------------------
// Reads: snapshot + log replay
// ---------------------------------------------------------------------------

/** What GET /api/pages/:id returns besides the page row; `seq` is the snapshot's log position. */
export interface PageSnapshot {
  seq: number;
  blocks: Block[];
  children: Page[];
  views: DatabaseView[];
}

/**
 * Reads blocks, child pages and views as one consistent snapshot together with
 * the page's last_op_seq (REPEATABLE READ), so a client can load the snapshot
 * and then replay exactly the operations after `seq`.
 */
export async function loadPageSnapshot(pageId: string, isDatabase: boolean): Promise<PageSnapshot> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const head = await client.query<{ last_op_seq: string }>(
      'SELECT last_op_seq FROM pages WHERE id = $1',
      [pageId]
    );
    const blocks = await client.query<Block>(
      'SELECT * FROM blocks WHERE page_id = $1 ORDER BY position, id',
      [pageId]
    );
    const children = await client.query<Page>(
      `SELECT * FROM pages WHERE parent_id = $1 AND is_archived = false ORDER BY position, id`,
      [pageId]
    );
    const views = isDatabase
      ? await client.query<DatabaseView>(
          'SELECT * FROM database_views WHERE page_id = $1 ORDER BY position, id',
          [pageId]
        )
      : { rows: [] as DatabaseView[] };
    await client.query('COMMIT');
    return {
      seq: Number(head.rows[0]?.last_op_seq ?? 0),
      blocks: blocks.rows,
      children: children.rows,
      views: views.rows,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

interface OperationRow {
  id: string;
  page_id: string;
  seq: string;
  block_id: string;
  type: BlockOperationType;
  data: { block?: Block };
  author_id: string | null;
  timestamp: string;
  created_at: Date;
}

/**
 * Operations after `sinceSeq`, in order. `complete` is false when the log
 * cannot fill the gap (more than `limit` operations, or rows no longer
 * retained); the client must then reload the page snapshot instead.
 */
export async function readOperationsSince(
  pageId: string,
  sinceSeq: number,
  limit: number
): Promise<{ ops: PageOperation[]; headSeq: number; complete: boolean }> {
  const head = await pool.query<{ last_op_seq: string }>(
    'SELECT last_op_seq FROM pages WHERE id = $1',
    [pageId]
  );
  const headSeq = Number(head.rows[0]?.last_op_seq ?? 0);
  if (sinceSeq >= headSeq) {
    return { ops: [], headSeq, complete: true };
  }

  const result = await pool.query<OperationRow>(
    `SELECT id, page_id, seq, block_id, type, data, author_id, timestamp, created_at
     FROM operations
     WHERE page_id = $1 AND seq > $2
     ORDER BY seq
     LIMIT $3`,
    [pageId, sinceSeq, limit + 1]
  );

  const ops = result.rows.map((row) => ({
    op_id: row.id,
    page_id: row.page_id,
    seq: Number(row.seq),
    block_id: row.block_id,
    type: row.type,
    block: row.type === 'delete' ? null : (row.data.block ?? null),
    author_id: row.author_id,
    timestamp: String(row.timestamp),
    created_at: new Date(row.created_at).toISOString(),
  }));

  // Writes that committed after `head` was read may already be in `ops`.
  const lastSeq = ops.length > 0 ? ops[ops.length - 1].seq : sinceSeq;
  const contiguous = ops.every((op, index) => op.seq === sinceSeq + index + 1);
  const complete = ops.length <= limit && contiguous && lastSeq >= headSeq;
  return { ops: complete ? ops : [], headSeq: Math.max(headSeq, lastSeq), complete };
}
