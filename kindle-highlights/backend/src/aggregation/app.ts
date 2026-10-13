/**
 * Aggregation Service: read APIs for popular highlights, trending passages and the heatmap.
 *
 * Everything here reads the published aggregate (popular_highlights), which only the
 * aggregation worker writes. The privacy threshold is enforced twice: the worker never
 * publishes a passage with fewer than MIN_READERS distinct readers, and every endpoint
 * filters again, so a caller can raise the threshold (`minCount`) but never lower it.
 *
 * @module aggregation/app
 */
import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import { query } from '../shared/db.js'
import { cacheGet, cacheSet, redis, withJitter } from '../shared/cache.js'
import { createLogger } from '../shared/logger.js'
import { errorHandler, HttpError } from '../shared/errors.js'
import { effectiveMinReaders, MIN_READERS } from '../shared/privacy.js'
import { passageIdFor } from '../shared/passage.js'
import { isUuid, parseLimit, parseNonNegative } from '../shared/validation.js'
import { heatmapCacheKey, popularCacheKey, WORKER_HEARTBEAT_KEY } from './keys.js'

const logger = createLogger('aggregation-service')

/** Popular passages per book kept in the cache; `limit` is applied after the read. */
const CACHED_TOP_N = 50
const POPULAR_TTL_SECONDS = 300
const TRENDING_TTL_SECONDS = 60
const HEATMAP_TTL_SECONDS = 60

export const app = express()

app.use(cors())
app.use(express.json())

/** Popular highlight data structure */
interface PopularHighlight {
  passage_id: string
  passage_text: string
  reader_count: number
  location_start: number
  location_end: number
  last_contribution_at: Date | null
}

/**
 * Health check: the service is up, plus how far behind the aggregate is. A worker can be
 * alive and stuck, so "degraded" means its heartbeat is stale or the outbox is backing up.
 */
app.get('/health', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const backlog = await query<{ pending: number; oldest_seconds: number | null }>(
      `SELECT COUNT(*)::int AS pending,
              EXTRACT(EPOCH FROM NOW() - MIN(created_at))::int AS oldest_seconds
       FROM aggregation_outbox`
    )
    const heartbeat = await redis.get(WORKER_HEARTBEAT_KEY)
    const workerAgeSeconds = heartbeat ? Math.round((Date.now() - Number(heartbeat)) / 1000) : null
    const { pending, oldest_seconds: oldestSeconds } = backlog.rows[0]
    const degraded = workerAgeSeconds === null || workerAgeSeconds > 120 || (oldestSeconds ?? 0) > 300

    res.json({
      status: degraded ? 'degraded' : 'ok',
      service: 'aggregation',
      minReaders: MIN_READERS,
      outbox: { pending, oldestSeconds },
      workerHeartbeatAgeSeconds: workerAgeSeconds,
    })
  } catch (error) {
    next(error)
  }
})

/** A book's published passages, most readers first (cache-aside, top 50). */
async function loadPopular(bookId: string): Promise<PopularHighlight[]> {
  const key = popularCacheKey(bookId)
  const cached = await cacheGet<PopularHighlight[]>(key)
  if (cached) return cached

  const result = await query<PopularHighlight>(
    `SELECT passage_id, passage_text, reader_count, location_start, location_end, last_contribution_at
     FROM popular_highlights
     WHERE book_id = $1 AND reader_count >= $2
     ORDER BY reader_count DESC, passage_id
     LIMIT $3`,
    [bookId, MIN_READERS, CACHED_TOP_N]
  )
  await cacheSet(key, result.rows, withJitter(POPULAR_TTL_SECONDS))
  return result.rows
}

/**
 * Get popular highlights for a book
 * GET /api/books/:bookId/popular?limit=10&minCount=
 */
app.get('/api/books/:bookId/popular', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const bookId = String(req.params.bookId)
    if (!isUuid(bookId)) throw new HttpError(400, 'bookId must be a UUID')
    const limit = parseLimit(req.query.limit, 10, CACHED_TOP_N)
    const minReaders = effectiveMinReaders(req.query.minCount)

    const passages = await loadPopular(bookId.toLowerCase())
    res.json(passages.filter((p) => p.reader_count >= minReaders).slice(0, limit))
  } catch (error) {
    next(error)
  }
})

/**
 * Get trending highlights across all books: published passages that gained a reader in the
 * last `days` days, ranked by readers.
 * GET /api/trending?limit=20&days=7
 */
app.get('/api/trending', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = parseLimit(req.query.limit, 20, 50)
    const days = Math.min(Math.max(parseNonNegative(req.query.days, 7), 1), 90)

    const cacheKey = `trending:${days}:${limit}`
    const cached = await cacheGet<unknown[]>(cacheKey)
    if (cached) {
      res.json(cached)
      return
    }

    const result = await query(
      `SELECT ph.passage_id, ph.passage_text, ph.reader_count, ph.location_start, ph.location_end,
              ph.last_contribution_at, ph.book_id, b.title as book_title, b.author as book_author
       FROM popular_highlights ph
       JOIN books b ON b.id = ph.book_id
       WHERE ph.reader_count >= $1
         AND ph.last_contribution_at > NOW() - make_interval(days => $2)
       ORDER BY ph.reader_count DESC, ph.last_contribution_at DESC
       LIMIT $3`,
      [MIN_READERS, days, limit]
    )

    await cacheSet(cacheKey, result.rows, withJitter(TRENDING_TTL_SECONDS))
    res.json(result.rows)
  } catch (error) {
    next(error)
  }
})

/**
 * Readers for the passage containing a location range. Below the threshold the passage is
 * not published, so the answer is `readers: null` rather than a small, identifying number.
 * GET /api/books/:bookId/count?start=&end=
 */
app.get('/api/books/:bookId/count', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const bookId = String(req.params.bookId)
    if (!isUuid(bookId)) throw new HttpError(400, 'bookId must be a UUID')
    const start = parseNonNegative(req.query.start, -1)
    const end = parseNonNegative(req.query.end, -1)
    if (start < 0 || end < start) throw new HttpError(400, 'start and end query parameters required')

    const passageId = passageIdFor(start, end)
    const result = await query<{ reader_count: number }>(
      `SELECT reader_count FROM popular_highlights
       WHERE book_id = $1 AND passage_id = $2 AND reader_count >= $3`,
      [bookId, passageId, MIN_READERS]
    )

    res.json({ passageId, readers: result.rows[0]?.reader_count ?? null })
  } catch (error) {
    next(error)
  }
})

/**
 * Reader density for every published passage of a book (for a margin heatmap)
 * GET /api/books/:bookId/heatmap
 */
app.get('/api/books/:bookId/heatmap', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const bookId = String(req.params.bookId)
    if (!isUuid(bookId)) throw new HttpError(400, 'bookId must be a UUID')

    const cacheKey = heatmapCacheKey(bookId.toLowerCase())
    const cached = await cacheGet<Record<string, number>>(cacheKey)
    if (cached) {
      res.json(cached)
      return
    }

    const result = await query<{ passage_id: string; reader_count: number }>(
      `SELECT passage_id, reader_count
       FROM popular_highlights
       WHERE book_id = $1 AND reader_count >= $2`,
      [bookId, MIN_READERS]
    )

    const heatmap: Record<string, number> = {}
    for (const row of result.rows) {
      heatmap[row.passage_id] = row.reader_count
    }

    await cacheSet(cacheKey, heatmap, withJitter(HEATMAP_TTL_SECONDS))
    res.json(heatmap)
  } catch (error) {
    next(error)
  }
})

/** Error handling middleware */
app.use(errorHandler(logger))
