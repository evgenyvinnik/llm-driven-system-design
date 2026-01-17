/**
 * Express app for Highlight Service
 * Handles CRUD operations for user highlights
 * @module highlight/app
 */
import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import { v4 as uuid } from 'uuid'
import { query, transaction } from '../shared/db.js'
import { authMiddleware, optionalAuthMiddleware } from '../shared/auth.js'
import { cacheGet, cacheSet, cacheDel, hashIncr, redis } from '../shared/cache.js'
import { createLogger } from '../shared/logger.js'

const logger = createLogger('highlight-service')

export const app = express()

app.use(cors())
app.use(express.json())

/** Highlight data structure */
interface Highlight {
  id: string
  user_id: string
  book_id: string
  location_start: number
  location_end: number
  highlighted_text: string
  note: string | null
  color: string
  visibility: string
  created_at: Date
  updated_at: Date
}

/** Create highlight request body */
interface CreateHighlightBody {
  bookId: string
  locationStart: number
  locationEnd: number
  text: string
  note?: string
  color?: string
  visibility?: string
  idempotencyKey?: string
}

/** Health check endpoint */
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'highlight' })
})

/**
 * Create a new highlight
 * POST /api/highlights
 */
app.post('/api/highlights', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const { bookId, locationStart, locationEnd, text, note, color = 'yellow', visibility = 'private', idempotencyKey } = req.body as CreateHighlightBody

    // Check idempotency
    if (idempotencyKey) {
      const existing = await cacheGet<Highlight>(`idempotency:${idempotencyKey}`)
      if (existing) {
        res.json(existing)
        return
      }
    }

    const highlightId = uuid()

    const result = await query<Highlight>(
      `INSERT INTO highlights
         (id, user_id, book_id, location_start, location_end, highlighted_text, note, color, visibility, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [highlightId, userId, bookId, locationStart, locationEnd, text, note || null, color, visibility, idempotencyKey || null]
    )

    const highlight = result.rows[0]

    // Update aggregation counters in Redis
    if (visibility !== 'private') {
      const passageId = normalizePassage(locationStart, locationEnd)
      await hashIncr(`book:${bookId}:highlights`, passageId, 1)
    }

    // Cache idempotency result
    if (idempotencyKey) {
      await cacheSet(`idempotency:${idempotencyKey}`, highlight, 86400)
    }

    // Invalidate user highlights cache
    await cacheDel(`user:${userId}:highlights`)

    logger.info({ event: 'highlight_created', userId, bookId, highlightId })

    res.status(201).json(highlight)
  } catch (error) {
    next(error)
  }
})

/**
 * Get user's highlights
 * GET /api/highlights
 */
app.get('/api/highlights', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const { bookId, search, limit = '50', offset = '0' } = req.query as Record<string, string>

    const cacheKey = `user:${userId}:highlights:${bookId || 'all'}:${search || ''}:${limit}:${offset}`
    const cached = await cacheGet<Highlight[]>(cacheKey)
    if (cached) {
      res.json(cached)
      return
    }

    let sql = `
      SELECT h.*, b.title as book_title, b.author as book_author
      FROM highlights h
      JOIN books b ON b.id = h.book_id
      WHERE h.user_id = $1 AND h.archived = false
    `
    const params: any[] = [userId]
    let paramIndex = 2

    if (bookId) {
      sql += ` AND h.book_id = $${paramIndex++}`
      params.push(bookId)
    }

    if (search) {
      sql += ` AND (h.highlighted_text ILIKE $${paramIndex} OR h.note ILIKE $${paramIndex})`
      params.push(`%${search}%`)
      paramIndex++
    }

    sql += ` ORDER BY h.created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`
    params.push(parseInt(limit), parseInt(offset))

    const result = await query(sql, params)

    await cacheSet(cacheKey, result.rows, 60) // Cache for 1 minute

    res.json(result.rows)
  } catch (error) {
    next(error)
  }
})

/**
 * Get a single highlight by ID
 * GET /api/highlights/:id
 */
app.get('/api/highlights/:id', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const { id } = req.params

    const result = await query<Highlight>(
      `SELECT h.*, b.title as book_title, b.author as book_author
       FROM highlights h
       JOIN books b ON b.id = h.book_id
       WHERE h.id = $1 AND h.user_id = $2`,
      [id, userId]
    )

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Highlight not found' })
      return
    }

    res.json(result.rows[0])
  } catch (error) {
    next(error)
  }
})

/**
 * Update a highlight
 * PATCH /api/highlights/:id
 */
app.patch('/api/highlights/:id', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const { id } = req.params
    const { note, color, visibility } = req.body

    const result = await query<Highlight>(
      `UPDATE highlights
       SET note = COALESCE($1, note),
           color = COALESCE($2, color),
           visibility = COALESCE($3, visibility),
           updated_at = NOW()
       WHERE id = $4 AND user_id = $5
       RETURNING *`,
      [note, color, visibility, id, userId]
    )

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Highlight not found' })
      return
    }

    await cacheDel(`user:${userId}:highlights`)

    logger.info({ event: 'highlight_updated', userId, highlightId: id })

    res.json(result.rows[0])
  } catch (error) {
    next(error)
  }
})

/**
 * Delete a highlight
 * DELETE /api/highlights/:id
 */
app.delete('/api/highlights/:id', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const { id } = req.params

    await transaction(async (client) => {
      // Get highlight before deletion for aggregation update
      const highlight = await client.query<Highlight>(
        'SELECT * FROM highlights WHERE id = $1 AND user_id = $2',
        [id, userId]
      )

      if (highlight.rows.length === 0) {
        throw new Error('Highlight not found')
      }

      const h = highlight.rows[0]

      // Soft delete for sync
      await client.query(
        'INSERT INTO deleted_highlights (highlight_id, user_id) VALUES ($1, $2)',
        [id, userId]
      )

      // Archive the highlight
      await client.query(
        'UPDATE highlights SET archived = true, updated_at = NOW() WHERE id = $1',
        [id]
      )

      // Update aggregation counters
      if (h.visibility !== 'private') {
        const passageId = normalizePassage(h.location_start, h.location_end)
        await hashIncr(`book:${h.book_id}:highlights`, passageId, -1)
      }
    })

    await cacheDel(`user:${userId}:highlights`)

    logger.info({ event: 'highlight_deleted', userId, highlightId: id })

    res.status(204).send()
  } catch (error: any) {
    if (error.message === 'Highlight not found') {
      res.status(404).json({ error: 'Highlight not found' })
      return
    }
    next(error)
  }
})

/**
 * Export highlights
 * GET /api/highlights/export
 */
app.get('/api/export/highlights', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const { format = 'markdown' } = req.query as { format?: string }

    const result = await query(
      `SELECT h.*, b.title as book_title, b.author as book_author
       FROM highlights h
       JOIN books b ON b.id = h.book_id
       WHERE h.user_id = $1 AND h.archived = false
       ORDER BY b.title, h.location_start`,
      [userId]
    )

    const highlights = result.rows

    if (format === 'markdown') {
      const markdown = formatAsMarkdown(highlights)
      res.setHeader('Content-Type', 'text/markdown')
      res.setHeader('Content-Disposition', 'attachment; filename=my-highlights.md')
      res.send(markdown)
    } else if (format === 'csv') {
      const csv = formatAsCSV(highlights)
      res.setHeader('Content-Type', 'text/csv')
      res.setHeader('Content-Disposition', 'attachment; filename=my-highlights.csv')
      res.send(csv)
    } else if (format === 'json') {
      res.setHeader('Content-Disposition', 'attachment; filename=my-highlights.json')
      res.json(highlights)
    } else {
      res.status(400).json({ error: 'Invalid format. Use markdown, csv, or json' })
    }

    logger.info({ event: 'highlights_exported', userId, format, count: highlights.length })
  } catch (error) {
    next(error)
  }
})

/**
 * Get books with highlight counts for user
 * GET /api/library
 */
app.get('/api/library', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!

    const result = await query(
      `SELECT b.*, COUNT(h.id) as highlight_count, MAX(h.created_at) as last_highlighted
       FROM books b
       JOIN highlights h ON h.book_id = b.id
       WHERE h.user_id = $1 AND h.archived = false
       GROUP BY b.id
       ORDER BY last_highlighted DESC`,
      [userId]
    )

    res.json(result.rows)
  } catch (error) {
    next(error)
  }
})

/**
 * Normalize passage location to a fixed window for aggregation
 */
function normalizePassage(start: number, end: number): string {
  const windowSize = 100
  const normalizedStart = Math.floor(start / windowSize) * windowSize
  const normalizedEnd = Math.ceil(end / windowSize) * windowSize
  return `${normalizedStart}-${normalizedEnd}`
}

/**
 * Format highlights as Markdown
 */
function formatAsMarkdown(highlights: any[]): string {
  const byBook: Record<string, { title: string; author: string; highlights: any[] }> = {}

  for (const h of highlights) {
    if (!byBook[h.book_id]) {
      byBook[h.book_id] = {
        title: h.book_title,
        author: h.book_author,
        highlights: [],
      }
    }
    byBook[h.book_id].highlights.push(h)
  }

  let md = '# My Highlights\n\n'

  for (const bookId in byBook) {
    const book = byBook[bookId]
    md += `## ${book.title}\n`
    md += `*by ${book.author}*\n\n`

    for (const h of book.highlights) {
      md += `> ${h.highlighted_text}\n\n`
      if (h.note) {
        md += `*Note: ${h.note}*\n\n`
      }
      md += `---\n\n`
    }
  }

  return md
}

/**
 * Format highlights as CSV
 */
function formatAsCSV(highlights: any[]): string {
  const headers = ['Book Title', 'Author', 'Highlighted Text', 'Note', 'Color', 'Date']
  const rows = highlights.map((h) => [
    h.book_title,
    h.book_author,
    `"${h.highlighted_text.replace(/"/g, '""')}"`,
    h.note ? `"${h.note.replace(/"/g, '""')}"` : '',
    h.color,
    new Date(h.created_at).toISOString(),
  ])

  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n')
}

/** Error handling middleware */
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ error: err.message, stack: err.stack })
  res.status(500).json({ error: 'Internal server error' })
})
