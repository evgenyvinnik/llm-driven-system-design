/**
 * The highlight write path, shared by the REST API (highlight service) and the offline
 * push endpoint (sync service), plus the change feed that devices pull from.
 *
 * Every write runs in one transaction that
 *   1. locks the owner's row in user_sync_state, which serializes that reader's writes,
 *   2. changes the highlight row and stamps it with the next sequence number, and
 *   3. inserts an aggregation_outbox row when the change can move a public count.
 * Because sequence numbers are taken under that lock, they are handed out in commit order and
 * a device's cursor can never skip a change. Callers notify other devices after the commit.
 *
 * @module shared/highlights
 */
import type pg from 'pg'
import { transaction } from './db.js'
import { HttpError } from './errors.js'
import { initialClock, mergeFieldUpdates, type FieldClock, type MutableField } from './lww.js'
import type { HighlightChanges, NewHighlight } from './validation.js'

/** A row of the highlights table as returned to clients. */
export interface HighlightRow {
  id: string
  user_id: string
  book_id: string
  location_start: number
  location_end: number
  highlighted_text: string
  note: string | null
  color: string
  visibility: string
  sync_seq: number
  field_clock: FieldClock
  deleted_at: Date | null
  created_at: Date
  updated_at: Date
}

/** Who made a change and when, according to the device. */
export interface WriteContext {
  deviceId: string
  /** The device's wall-clock time of the edit (epoch ms); the merge clamps it. */
  clientTs: number
}

export type CreateResult = { status: 'created' | 'replayed'; highlight: HighlightRow; seq: number | null }

/**
 * applied: at least one field changed. superseded: nothing changed because a newer edit won.
 * unchanged: nothing to do (a replayed edit). gone: the highlight is a tombstone.
 */
export type UpdateResult =
  | { status: 'applied'; highlight: HighlightRow; seq: number; applied: MutableField[]; superseded: MutableField[] }
  | { status: 'superseded' | 'unchanged'; highlight: HighlightRow; seq: null; applied: MutableField[]; superseded: MutableField[] }
  | { status: 'gone'; highlight: HighlightRow; seq: null }
  | { status: 'not_found'; seq: null }

export type DeleteResult =
  | { status: 'deleted' | 'gone'; highlight: HighlightRow; seq: number | null }
  | { status: 'not_found'; seq: null }

/** A page of the owner's change feed. */
export interface ChangePage {
  changes: HighlightRow[]
  cursor: number
  hasMore: boolean
  /** The cursor can't be served incrementally; the device must drop local state and pull from 0. */
  resync: boolean
}

/** Locks the owner's feed row (creating it on the first write) and returns the last sequence issued. */
async function lockFeed(client: pg.PoolClient, userId: string): Promise<number> {
  await client.query('INSERT INTO user_sync_state (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId])
  const result = await client.query<{ last_seq: number }>(
    'SELECT last_seq FROM user_sync_state WHERE user_id = $1 FOR UPDATE',
    [userId]
  )
  return result.rows[0].last_seq
}

async function advanceFeed(client: pg.PoolClient, userId: string, seq: number): Promise<void> {
  await client.query('UPDATE user_sync_state SET last_seq = $2 WHERE user_id = $1', [userId, seq])
}

/** Transactional outbox: the aggregation worker recomputes this book after the commit. */
export async function enqueueRecount(client: pg.PoolClient, bookId: string, reason: string): Promise<void> {
  await client.query('INSERT INTO aggregation_outbox (book_id, reason) VALUES ($1, $2)', [bookId, reason])
}

/** The visibility a reader chose for new highlights ('private' when never set). */
async function defaultVisibility(client: pg.PoolClient, userId: string): Promise<string> {
  const result = await client.query<{ highlight_visibility: string | null }>(
    'SELECT highlight_visibility FROM user_privacy_settings WHERE user_id = $1',
    [userId]
  )
  return result.rows[0]?.highlight_visibility ?? 'private'
}

/** True when a retried create describes the same highlight as the stored row. */
export function sameHighlight(row: HighlightRow, input: NewHighlight): boolean {
  return (
    row.book_id === input.bookId &&
    row.location_start === input.locationStart &&
    row.location_end === input.locationEnd &&
    row.highlighted_text === input.text
  )
}

/**
 * Creates a highlight whose id was minted by the client. A retry of an upload that already
 * succeeded hits the primary key and gets the stored row back ('replayed') without consuming
 * a sequence number or counting the passage twice; reusing an id for different content is a 422.
 */
export async function createHighlight(
  userId: string,
  input: NewHighlight & { id: string },
  ctx: WriteContext
): Promise<CreateResult> {
  return transaction(async (client) => {
    const seq = (await lockFeed(client, userId)) + 1
    const clock = initialClock(ctx.clientTs, ctx.deviceId, Date.now())
    const visibility = input.visibility ?? (await defaultVisibility(client, userId))
    const inserted = await client.query<HighlightRow>(
      `INSERT INTO highlights
         (id, user_id, book_id, location_start, location_end, highlighted_text, note, color, visibility,
          sync_seq, field_clock)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO NOTHING
       RETURNING *`,
      [
        input.id,
        userId,
        input.bookId,
        input.locationStart,
        input.locationEnd,
        input.text,
        input.note,
        input.color,
        visibility,
        seq,
        JSON.stringify(clock),
      ]
    )

    if (inserted.rows.length === 1) {
      await advanceFeed(client, userId, seq)
      if (visibility === 'public') await enqueueRecount(client, input.bookId, 'create')
      return { status: 'created', highlight: inserted.rows[0], seq }
    }

    // The id exists already, so this is a retry. Answer with what we have, never a duplicate.
    const existing = await client.query<HighlightRow>('SELECT * FROM highlights WHERE id = $1', [input.id])
    const row = existing.rows[0]
    if (!row || row.user_id !== userId) throw new HttpError(409, 'Highlight id is already in use')
    if (!row.deleted_at && !sameHighlight(row, input)) {
      throw new HttpError(422, 'Highlight id was already used for a different highlight')
    }
    return { status: 'replayed', highlight: row, seq: null }
  })
}

/**
 * Applies an edit with field-level last-writer-wins. A deleted highlight accepts no edits
 * ('gone'): delete wins over a concurrent edit, so a note typed offline can't resurrect it.
 */
export async function updateHighlight(
  userId: string,
  id: string,
  changes: HighlightChanges,
  ctx: WriteContext
): Promise<UpdateResult> {
  return transaction(async (client) => {
    const lastSeq = await lockFeed(client, userId)
    const found = await client.query<HighlightRow>(
      'SELECT * FROM highlights WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [id, userId]
    )
    const row = found.rows[0]
    if (!row) return { status: 'not_found', seq: null }
    if (row.deleted_at) return { status: 'gone', highlight: row, seq: null }

    const merge = mergeFieldUpdates({
      current: { note: row.note, color: row.color, visibility: row.visibility },
      clock: row.field_clock,
      changes,
      clientTs: ctx.clientTs,
      deviceId: ctx.deviceId,
      serverNow: Date.now(),
    })
    if (merge.applied.length === 0) {
      const status = merge.superseded.length > 0 ? 'superseded' : 'unchanged'
      return { status, highlight: row, seq: null, applied: [], superseded: merge.superseded }
    }

    const seq = lastSeq + 1
    const updated = await client.query<HighlightRow>(
      `UPDATE highlights
       SET note = $3, color = $4, visibility = $5, field_clock = $6, sync_seq = $7, updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [id, userId, merge.next.note, merge.next.color, merge.next.visibility, JSON.stringify(merge.clock), seq]
    )
    await advanceFeed(client, userId, seq)

    const before = row.visibility
    const after = merge.next.visibility
    if (before !== after && (before === 'public' || after === 'public')) {
      await enqueueRecount(client, row.book_id, 'visibility')
    }
    return { status: 'applied', highlight: updated.rows[0], seq, applied: merge.applied, superseded: merge.superseded }
  })
}

/**
 * Deletes a highlight by turning its row into a tombstone: the row stays (so the delete reaches
 * devices that were offline) but the reader's text and note are wiped. Deleting twice is a no-op.
 */
export async function deleteHighlight(userId: string, id: string): Promise<DeleteResult> {
  return transaction(async (client) => {
    const lastSeq = await lockFeed(client, userId)
    const found = await client.query<HighlightRow>(
      'SELECT * FROM highlights WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [id, userId]
    )
    const row = found.rows[0]
    if (!row) return { status: 'not_found', seq: null }
    if (row.deleted_at) return { status: 'gone', highlight: row, seq: null }

    const seq = lastSeq + 1
    const tombstone = await client.query<HighlightRow>(
      `UPDATE highlights
       SET deleted_at = NOW(), note = NULL, highlighted_text = '', sync_seq = $3, updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [id, userId, seq]
    )
    await advanceFeed(client, userId, seq)
    if (row.visibility === 'public') await enqueueRecount(client, row.book_id, 'delete')
    return { status: 'deleted', highlight: tombstone.rows[0], seq }
  })
}

/**
 * Returns the owner's changes after `since`, oldest first. Rows hold only their latest state,
 * so a device that was away for a month receives each changed highlight once. The cursor and
 * the rows come from one REPEATABLE READ snapshot, so the cursor never runs ahead of the rows.
 */
export async function changesSince(userId: string, since: number, limit: number): Promise<ChangePage> {
  return transaction(
    async (client) => {
      const state = await client.query<{ last_seq: number; purged_through_seq: number }>(
        'SELECT last_seq, purged_through_seq FROM user_sync_state WHERE user_id = $1',
        [userId]
      )
      const lastSeq = state.rows[0]?.last_seq ?? 0
      const purgedThrough = state.rows[0]?.purged_through_seq ?? 0

      // Tombstones below the cursor were reaped (or the cursor is from a reset database):
      // an incremental answer could miss a delete, so the device must start over.
      if ((since > 0 && since < purgedThrough) || since > lastSeq) {
        return { changes: [], cursor: 0, hasMore: false, resync: true }
      }

      const rows = await client.query<HighlightRow>(
        `SELECT * FROM highlights
         WHERE user_id = $1 AND sync_seq > $2
         ORDER BY sync_seq
         LIMIT $3`,
        [userId, since, limit + 1]
      )
      const hasMore = rows.rows.length > limit
      const changes = rows.rows.slice(0, limit)
      const cursor = hasMore ? changes[changes.length - 1].sync_seq : lastSeq
      return { changes, cursor, hasMore, resync: false }
    },
    { snapshot: true }
  )
}
