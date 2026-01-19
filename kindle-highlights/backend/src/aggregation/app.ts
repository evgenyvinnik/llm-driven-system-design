/**
 * Aggregation Service for popular highlights
 * @module aggregation/app
 */
import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import { query } from '../shared/db.js'
import { cacheGet, cacheSet, hashGetAll, redis, _initRedis } from '../shared/cache.js'
import { createLogger } from '../shared/logger.js'

const logger = createLogger('aggregation-service')

export const app = express()

app.use(cors())
app.use(express.json())

/** Popular highlight data structure */
interface PopularHighlight {
  passage_id: string
  passage_text: string
  highlight_count: number
  location_start: number
  location_end: number
}

/** Health check endpoint */
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'aggregation' })
})

/**
 * Get popular highlights for a book
 * GET /api/books/:bookId/popular
 */
app.get('/api/books/:bookId/popular', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { bookId } = req.params
    const { limit = '10', minCount = '3' } = req.query as Record<string, string>

    const cacheKey = `popular:${bookId}:${limit}:${minCount}`
    const cached = await cacheGet<PopularHighlight[]>(cacheKey)
    if (cached) {
      res.json(cached)
      return
    }

    const result = await query<PopularHighlight>(
      `SELECT passage_id, passage_text, highlight_count, location_start, location_end
       FROM popular_highlights
       WHERE book_id = $1 AND highlight_count >= $2
       ORDER BY highlight_count DESC
       LIMIT $3`,
      [bookId, parseInt(minCount), parseInt(limit)]
    )

    await cacheSet(cacheKey, result.rows, 300) // Cache for 5 minutes

    res.json(result.rows)
  } catch (error) {
    next(error)
  }
})

/**
 * Get trending highlights across all books
 * GET /api/trending
 */
app.get('/api/trending', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { limit = '20', days = '7' } = req.query as Record<string, string>

    const cacheKey = `trending:${limit}:${days}`
    const cached = await cacheGet<any[]>(cacheKey)
    if (cached) {
      res.json(cached)
      return
    }

    const result = await query(
      `SELECT ph.*, b.title as book_title, b.author as book_author
       FROM popular_highlights ph
       JOIN books b ON b.id = ph.book_id
       WHERE ph.updated_at > NOW() - INTERVAL '${parseInt(days)} days'
       ORDER BY ph.highlight_count DESC
       LIMIT $1`,
      [parseInt(limit)]
    )

    await cacheSet(cacheKey, result.rows, 600) // Cache for 10 minutes

    res.json(result.rows)
  } catch (error) {
    next(error)
  }
})

/**
 * Get highlight count for a specific passage
 * GET /api/books/:bookId/count
 */
app.get('/api/books/:bookId/count', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { bookId } = req.params
    const { start, end } = req.query as Record<string, string>

    if (!start || !end) {
      res.status(400).json({ error: 'start and end query parameters required' })
      return
    }

    const passageId = normalizePassage(parseInt(start), parseInt(end))

    // Try Redis first
    const redisCount = await redis.hGet(`book:${bookId}:highlights`, passageId)
    if (redisCount) {
      res.json({ count: parseInt(redisCount) })
      return
    }

    // Fall back to PostgreSQL
    const result = await query<{ highlight_count: number }>(
      `SELECT highlight_count FROM popular_highlights
       WHERE book_id = $1 AND passage_id = $2`,
      [bookId, passageId]
    )

    res.json({ count: result.rows[0]?.highlight_count || 0 })
  } catch (error) {
    next(error)
  }
})

/**
 * Get all highlight counts for a book (for highlighting UI)
 * GET /api/books/:bookId/heatmap
 */
app.get('/api/books/:bookId/heatmap', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { bookId } = req.params

    const cacheKey = `heatmap:${bookId}`
    const cached = await cacheGet<Record<string, number>>(cacheKey)
    if (cached) {
      res.json(cached)
      return
    }

    // Get from Redis first
    const redisData = await hashGetAll(`book:${bookId}:highlights`)
    if (Object.keys(redisData).length > 0) {
      const heatmap: Record<string, number> = {}
      for (const [passageId, count] of Object.entries(redisData)) {
        heatmap[passageId] = parseInt(count)
      }
      await cacheSet(cacheKey, heatmap, 60)
      res.json(heatmap)
      return
    }

    // Fall back to PostgreSQL
    const result = await query<{ passage_id: string; highlight_count: number }>(
      `SELECT passage_id, highlight_count
       FROM popular_highlights
       WHERE book_id = $1`,
      [bookId]
    )

    const heatmap: Record<string, number> = {}
    for (const row of result.rows) {
      heatmap[row.passage_id] = row.highlight_count
    }

    await cacheSet(cacheKey, heatmap, 60)

    res.json(heatmap)
  } catch (error) {
    next(error)
  }
})

/**
 * Normalize passage location to a fixed window
 */
function normalizePassage(start: number, end: number): string {
  const windowSize = 100
  const normalizedStart = Math.floor(start / windowSize) * windowSize
  const normalizedEnd = Math.ceil(end / windowSize) * windowSize
  return `${normalizedStart}-${normalizedEnd}`
}

/** Error handling middleware */
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ error: err.message, stack: err.stack })
  res.status(500).json({ error: 'Internal server error' })
})
