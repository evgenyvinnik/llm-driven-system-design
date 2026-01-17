/**
 * Background worker for aggregating highlight counts
 * Syncs Redis counters to PostgreSQL periodically
 * @module aggregation/worker
 */
import { query } from '../shared/db.js'
import { redis, initRedis, hashGetAll } from '../shared/cache.js'
import { createLogger } from '../shared/logger.js'

const logger = createLogger('aggregation-worker')
const AGGREGATION_INTERVAL = parseInt(process.env.AGGREGATION_INTERVAL || '60000') // 1 minute

/**
 * Run aggregation job - sync Redis counters to PostgreSQL
 */
async function runAggregationJob(): Promise<void> {
  logger.info({ event: 'aggregation_started' })

  try {
    // Get all book highlight keys from Redis
    const keys = await redis.keys('book:*:highlights')

    let processedBooks = 0
    let totalPassages = 0

    for (const key of keys) {
      const bookId = key.split(':')[1]
      const passages = await hashGetAll(key)

      for (const [passageId, countStr] of Object.entries(passages)) {
        const count = parseInt(countStr)

        // Get sample text for the passage
        const sample = await getPassageSample(bookId, passageId)

        // Upsert to PostgreSQL
        await query(
          `INSERT INTO popular_highlights
             (book_id, passage_id, passage_text, highlight_count, location_start, location_end, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (book_id, passage_id) DO UPDATE SET
             highlight_count = $4,
             passage_text = COALESCE(NULLIF($3, ''), popular_highlights.passage_text),
             updated_at = NOW()`,
          [bookId, passageId, sample.text, count, sample.start, sample.end]
        )

        totalPassages++
      }

      processedBooks++
    }

    logger.info({
      event: 'aggregation_completed',
      processedBooks,
      totalPassages,
    })
  } catch (error: any) {
    logger.error({ event: 'aggregation_failed', error: error.message })
  }
}

/**
 * Get a sample highlight text for a passage
 */
async function getPassageSample(bookId: string, passageId: string): Promise<{ text: string; start: number; end: number }> {
  const [startStr, endStr] = passageId.split('-')
  const start = parseInt(startStr)
  const end = parseInt(endStr)

  const result = await query<{ highlighted_text: string; location_start: number; location_end: number }>(
    `SELECT highlighted_text, location_start, location_end
     FROM highlights
     WHERE book_id = $1
       AND location_start >= $2
       AND location_end <= $3
       AND visibility != 'private'
     LIMIT 1`,
    [bookId, start, end]
  )

  if (result.rows[0]) {
    return {
      text: result.rows[0].highlighted_text,
      start: result.rows[0].location_start,
      end: result.rows[0].location_end,
    }
  }

  return { text: '', start, end }
}

/**
 * Clean up stale aggregation data
 */
async function cleanupStaleData(): Promise<void> {
  logger.info({ event: 'cleanup_started' })

  try {
    // Remove passages with zero or negative counts
    const result = await query(
      `DELETE FROM popular_highlights
       WHERE highlight_count <= 0`
    )

    logger.info({
      event: 'cleanup_completed',
      deletedRows: result.rowCount,
    })
  } catch (error: any) {
    logger.error({ event: 'cleanup_failed', error: error.message })
  }
}

/**
 * Start the worker
 */
async function start(): Promise<void> {
  await initRedis()

  logger.info({ event: 'worker_started', interval: AGGREGATION_INTERVAL })
  console.log(`Aggregation worker running (interval: ${AGGREGATION_INTERVAL}ms)`)

  // Run immediately on start
  await runAggregationJob()

  // Then run periodically
  setInterval(runAggregationJob, AGGREGATION_INTERVAL)

  // Run cleanup every hour
  setInterval(cleanupStaleData, 3600000)
}

start().catch((err) => {
  logger.error({ event: 'worker_startup_failed', error: err.message })
  process.exit(1)
})
