/**
 * Background worker that keeps popular_highlights in step with the highlights table.
 *
 * Writes that can change a book's public counts insert a row into aggregation_outbox in the
 * same transaction. This worker drains the outbox one book at a time: it recomputes the book
 * from the source of truth (distinct consenting readers per passage), publishes only passages
 * at or above the privacy threshold, and deletes the outbox rows in the same transaction. A
 * crash before COMMIT leaves the rows in place, so every change is counted at least once, and
 * a recount is idempotent, so counting twice is harmless.
 *
 * Also runs maintenance: a periodic reconcile (requeue every book, e.g. after the threshold
 * changes) and reaping of tombstones older than the retention window.
 *
 * @module aggregation/worker
 */
import { transaction, query } from '../shared/db.js'
import { redis, initRedis, cacheDel } from '../shared/cache.js'
import { createLogger } from '../shared/logger.js'
import { onShutdown } from '../shared/lifecycle.js'
import { aggregatePassages, type Contribution } from '../shared/passage.js'
import { MIN_READERS } from '../shared/privacy.js'
import { heatmapCacheKey, popularCacheKey, WORKER_HEARTBEAT_KEY } from './keys.js'

const logger = createLogger('aggregation-worker')
const AGGREGATION_INTERVAL = parseInt(process.env.AGGREGATION_INTERVAL || '10000', 10)
const MAX_BOOKS_PER_CYCLE = 200
const RECONCILE_INTERVAL = parseInt(process.env.RECONCILE_INTERVAL || String(6 * 3600 * 1000), 10)
const TOMBSTONE_PURGE_INTERVAL = 3600 * 1000
const TOMBSTONE_RETENTION_DAYS = parseInt(process.env.TOMBSTONE_RETENTION_DAYS || '90', 10)

let running = true
let wake: (() => void) | null = null

/**
 * Recounts the book of the oldest outbox row that no other worker holds.
 * Returns the book id, or null when there is nothing to do. Throws (and rolls back, leaving
 * the outbox rows for a retry) if the recount fails; `claimed.bookId` names the book.
 */
async function recountNextBook(skip: string[], claimed: { bookId: string | null }): Promise<string | null> {
  return transaction(async (client) => {
    const next = await client.query<{ book_id: string }>(
      `SELECT book_id FROM aggregation_outbox
       WHERE NOT (book_id = ANY($1::uuid[]))
       ORDER BY id
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [skip]
    )
    const bookId = next.rows[0]?.book_id
    if (!bookId) return null
    claimed.bookId = bookId

    // Two workers may claim rows of the same book; serialize their recounts so an older
    // snapshot can never overwrite a newer one.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`popular:${bookId}`])

    // Consume the book's pending rows BEFORE reading highlights: any row deleted here belongs
    // to a change that committed before this statement, so the read below is sure to see it.
    // A change committing later leaves its row behind for the next cycle.
    const consumed = await client.query(
      `DELETE FROM aggregation_outbox
       WHERE id IN (SELECT id FROM aggregation_outbox WHERE book_id = $1 FOR UPDATE SKIP LOCKED)`,
      [bookId]
    )

    // Eligible contributions: public, not deleted, from readers who haven't opted out.
    const rows = await client.query<{
      user_id: string
      location_start: number
      location_end: number
      highlighted_text: string
      created_at: Date
    }>(
      `SELECT h.user_id, h.location_start, h.location_end, h.highlighted_text, h.created_at
       FROM highlights h
       LEFT JOIN user_privacy_settings ups ON ups.user_id = h.user_id
       WHERE h.book_id = $1
         AND h.visibility = 'public'
         AND h.deleted_at IS NULL
         AND COALESCE(ups.include_in_aggregation, true)`,
      [bookId]
    )
    const contributions: Contribution[] = rows.rows.map((r) => ({
      userId: r.user_id,
      locationStart: r.location_start,
      locationEnd: r.location_end,
      text: r.highlighted_text,
      createdAt: r.created_at,
    }))
    const passages = aggregatePassages(contributions, MIN_READERS)

    // Replace the book's published passages; passages that fell below the threshold disappear.
    await client.query(
      'DELETE FROM popular_highlights WHERE book_id = $1 AND NOT (passage_id = ANY($2::text[]))',
      [bookId, passages.map((p) => p.passageId)]
    )
    for (const p of passages) {
      await client.query(
        `INSERT INTO popular_highlights
           (book_id, passage_id, passage_text, reader_count, location_start, location_end,
            last_contribution_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (book_id, passage_id) DO UPDATE SET
           passage_text = EXCLUDED.passage_text,
           reader_count = EXCLUDED.reader_count,
           location_start = EXCLUDED.location_start,
           location_end = EXCLUDED.location_end,
           last_contribution_at = EXCLUDED.last_contribution_at,
           updated_at = NOW()`,
        [bookId, p.passageId, p.passageText, p.readerCount, p.locationStart, p.locationEnd, p.lastContributionAt]
      )
    }

    logger.info({
      event: 'book_recounted',
      bookId,
      outboxRows: consumed.rowCount,
      contributions: contributions.length,
      published: passages.length,
    })
    return bookId
  })
}

/** Drains up to MAX_BOOKS_PER_CYCLE books from the outbox. A failing book is skipped this cycle. */
async function runCycle(): Promise<void> {
  const skip: string[] = []
  let recounted = 0

  while (running && recounted < MAX_BOOKS_PER_CYCLE) {
    const claimed: { bookId: string | null } = { bookId: null }
    try {
      const bookId = await recountNextBook(skip, claimed)
      if (!bookId) break
      recounted++
      // Invalidate after COMMIT: the next read refills from the table. A reader that loaded the
      // old rows just before the commit can re-cache them for at most one TTL (5 minutes),
      // which is inside the freshness budget of a popular-highlights count.
      await cacheDel(popularCacheKey(bookId), heatmapCacheKey(bookId))
    } catch (error) {
      logger.error({ event: 'recount_failed', bookId: claimed.bookId, error: (error as Error).message })
      if (!claimed.bookId) break
      skip.push(claimed.bookId)
    }
  }

  await redis.set(WORKER_HEARTBEAT_KEY, String(Date.now()), { EX: 600 })
  if (recounted > 0) logger.info({ event: 'aggregation_cycle_completed', recounted, skipped: skip.length })
}

/**
 * Requeues every book with public highlights or published passages. Covers changes made
 * outside the write path (manual SQL, a changed threshold, a fixed aggregation bug).
 */
async function reconcileAllBooks(): Promise<void> {
  const result = await query(
    `INSERT INTO aggregation_outbox (book_id, reason)
     SELECT book_id, 'reconcile' FROM (
       SELECT book_id FROM highlights WHERE visibility = 'public'
       UNION
       SELECT book_id FROM popular_highlights
     ) books`
  )
  logger.info({ event: 'reconcile_enqueued', books: result.rowCount })
}

/**
 * Reaps tombstones older than the retention window and records, per user, the highest
 * sequence number reaped. A device whose cursor is below that mark could miss a delete, so
 * the change feed tells it to resync from scratch instead.
 */
async function purgeTombstones(): Promise<void> {
  const result = await query(
    `WITH purged AS (
       DELETE FROM highlights
       WHERE deleted_at < NOW() - make_interval(days => $1)
       RETURNING user_id, sync_seq
     ), per_user AS (
       SELECT user_id, MAX(sync_seq) AS max_seq FROM purged GROUP BY user_id
     )
     UPDATE user_sync_state s
     SET purged_through_seq = GREATEST(s.purged_through_seq, p.max_seq)
     FROM per_user p
     WHERE s.user_id = p.user_id`,
    [TOMBSTONE_RETENTION_DAYS]
  )
  logger.info({ event: 'tombstones_purged', users: result.rowCount, retentionDays: TOMBSTONE_RETENTION_DAYS })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    wake = () => {
      clearTimeout(timer)
      resolve()
    }
  })
}

/** Runs cycles back to back (never overlapping), with maintenance on its own schedule. */
async function loop(): Promise<void> {
  let nextReconcile = 0
  let nextPurge = 0
  while (running) {
    try {
      if (Date.now() >= nextReconcile) {
        await reconcileAllBooks()
        nextReconcile = Date.now() + RECONCILE_INTERVAL
      }
      if (Date.now() >= nextPurge) {
        await purgeTombstones()
        nextPurge = Date.now() + TOMBSTONE_PURGE_INTERVAL
      }
      await runCycle()
    } catch (error) {
      logger.error({ event: 'aggregation_cycle_failed', error: (error as Error).message })
    }
    if (running) await sleep(AGGREGATION_INTERVAL)
  }
}

/**
 * Start the worker
 */
async function start(): Promise<void> {
  await initRedis()

  logger.info({ event: 'worker_started', interval: AGGREGATION_INTERVAL, minReaders: MIN_READERS })
  console.log(`Aggregation worker running (interval: ${AGGREGATION_INTERVAL}ms, threshold: ${MIN_READERS} readers)`)

  const done = loop()
  onShutdown(logger, async () => {
    running = false
    wake?.()
    await done
  })
}

start().catch((err) => {
  logger.error({ event: 'worker_startup_failed', error: err.message })
  process.exit(1)
})
