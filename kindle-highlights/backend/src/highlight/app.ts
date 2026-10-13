/**
 * Express app for Highlight Service
 * Handles CRUD operations for user highlights
 * @module highlight/app
 */
import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import { v4 as uuid, v5 as uuidv5 } from 'uuid'
import { query } from '../shared/db.js'
import { authMiddleware } from '../shared/auth.js'
import { createLogger } from '../shared/logger.js'
import { errorHandler, HttpError } from '../shared/errors.js'
import { createHighlight, deleteHighlight, updateHighlight } from '../shared/highlights.js'
import { deviceIdFrom, notifyDevices } from '../shared/notify.js'
import {
  isUuid,
  parseClientTimestamp,
  parseHighlightChanges,
  parseLimit,
  parseNewHighlight,
  parseNonNegative,
} from '../shared/validation.js'

const logger = createLogger('highlight-service')

/** Namespace for deriving a highlight id from an Idempotency-Key header (RFC 4122 v5). */
const IDEMPOTENCY_NAMESPACE = '6f1c5d2e-8a43-4b8e-9f0a-3c7d2b1e4a55'

export const app = express()

app.use(cors())
app.use(express.json())

/** Health check endpoint */
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'highlight' })
})

/**
 * Create a new highlight
 * POST /api/highlights
 *
 * The client should send the highlight's `id` (a UUID minted on the device): retrying with
 * the same id returns the original highlight (200, Idempotent-Replayed: true) instead of a
 * duplicate. Clients that can't mint ids may send an Idempotency-Key header instead; the id
 * is then derived from (user, key), which scopes keys per user.
 */
app.post('/api/highlights', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const parsed = parseNewHighlight(req.body)
    if (!parsed.ok) throw new HttpError(400, parsed.error)

    const idempotencyKey = req.header('Idempotency-Key')
    const id = parsed.value.id ?? (idempotencyKey ? uuidv5(`${userId}:${idempotencyKey}`, IDEMPOTENCY_NAMESPACE) : uuid())
    const deviceId = deviceIdFrom(req)
    const clientTs = parseClientTimestamp(req.body.clientUpdatedAt, Date.now())

    const result = await createHighlight(userId, { ...parsed.value, id }, { deviceId, clientTs })

    if (result.status === 'replayed') {
      res.setHeader('Idempotent-Replayed', 'true')
      res.status(200).json(result.highlight)
      return
    }

    await notifyDevices(userId, result.seq!, deviceId, logger)
    logger.info({ event: 'highlight_created', userId, bookId: parsed.value.bookId, highlightId: id, seq: result.seq })
    res.status(201).json(result.highlight)
  } catch (error) {
    next(error)
  }
})

/**
 * Get user's highlights (newest first)
 * GET /api/highlights?bookId=&search=&limit=&offset=
 *
 * Not cached: it is a small, indexed, user-scoped read, and caching it would mean
 * invalidating every variant of the key on every write.
 */
app.get('/api/highlights', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const { bookId, search } = req.query as Record<string, string | undefined>
    const limit = parseLimit(req.query.limit, 50, 200)
    const offset = parseNonNegative(req.query.offset, 0)

    let sql = `
      SELECT h.*, b.title as book_title, b.author as book_author
      FROM highlights h
      JOIN books b ON b.id = h.book_id
      WHERE h.user_id = $1 AND h.deleted_at IS NULL
    `
    const params: unknown[] = [userId]
    let paramIndex = 2

    if (bookId) {
      if (!isUuid(bookId)) throw new HttpError(400, 'bookId must be a UUID')
      sql += ` AND h.book_id = $${paramIndex++}`
      params.push(bookId)
    }

    if (search) {
      sql += ` AND (h.highlighted_text ILIKE $${paramIndex} OR h.note ILIKE $${paramIndex})`
      params.push(`%${search}%`)
      paramIndex++
    }

    sql += ` ORDER BY h.created_at DESC, h.id LIMIT $${paramIndex++} OFFSET $${paramIndex}`
    params.push(limit, offset)

    const result = await query(sql, params)
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
    const id = String(req.params.id)
    if (!isUuid(id)) throw new HttpError(400, 'id must be a UUID')

    const result = await query(
      `SELECT h.*, b.title as book_title, b.author as book_author
       FROM highlights h
       JOIN books b ON b.id = h.book_id
       WHERE h.id = $1 AND h.user_id = $2`,
      [id, userId]
    )

    const highlight = result.rows[0]
    if (!highlight) throw new HttpError(404, 'Highlight not found')
    if (highlight.deleted_at) throw new HttpError(410, 'Highlight was deleted')

    res.json(highlight)
  } catch (error) {
    next(error)
  }
})

/**
 * Update a highlight's note, color or visibility
 * PATCH /api/highlights/:id
 *
 * Conflicts between devices are resolved per field by last-writer-wins on the device's
 * `clientUpdatedAt` (defaults to now). `note: null` clears the note.
 */
app.patch('/api/highlights/:id', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const id = String(req.params.id)
    if (!isUuid(id)) throw new HttpError(400, 'id must be a UUID')
    const parsed = parseHighlightChanges(req.body)
    if (!parsed.ok) throw new HttpError(400, parsed.error)

    const deviceId = deviceIdFrom(req)
    const clientTs = parseClientTimestamp(req.body.clientUpdatedAt, Date.now())
    const result = await updateHighlight(userId, id.toLowerCase(), parsed.value, { deviceId, clientTs })

    if (result.status === 'not_found') throw new HttpError(404, 'Highlight not found')
    if (result.status === 'gone') throw new HttpError(410, 'Highlight was deleted')
    if (result.status === 'applied') {
      await notifyDevices(userId, result.seq, deviceId, logger)
      logger.info({ event: 'highlight_updated', userId, highlightId: id, applied: result.applied, seq: result.seq })
    }

    // 'superseded' still answers 200 with the current state: a newer edit already won.
    res.setHeader('X-Merge-Result', result.status)
    res.json(result.highlight)
  } catch (error) {
    next(error)
  }
})

/**
 * Delete a highlight (tombstone). Idempotent: deleting twice answers 204 both times.
 * DELETE /api/highlights/:id
 */
app.delete('/api/highlights/:id', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const id = String(req.params.id)
    if (!isUuid(id)) throw new HttpError(400, 'id must be a UUID')

    const result = await deleteHighlight(userId, id.toLowerCase())
    if (result.status === 'not_found') throw new HttpError(404, 'Highlight not found')
    if (result.status === 'deleted') {
      await notifyDevices(userId, result.seq!, deviceIdFrom(req), logger)
      logger.info({ event: 'highlight_deleted', userId, highlightId: id, seq: result.seq })
    }

    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

/**
 * Export highlights
 * GET /api/export/highlights?format=markdown|csv|json
 */
app.get('/api/export/highlights', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const { format = 'markdown' } = req.query as { format?: string }
    if (!['markdown', 'csv', 'json'].includes(format)) {
      throw new HttpError(400, 'Invalid format. Use markdown, csv, or json')
    }

    const result = await query<ExportRow>(
      `SELECT h.*, b.title as book_title, b.author as book_author
       FROM highlights h
       JOIN books b ON b.id = h.book_id
       WHERE h.user_id = $1 AND h.deleted_at IS NULL
       ORDER BY b.title, h.location_start`,
      [userId]
    )

    const highlights = result.rows

    if (format === 'markdown') {
      res.setHeader('Content-Type', 'text/markdown')
      res.setHeader('Content-Disposition', 'attachment; filename=my-highlights.md')
      res.send(formatAsMarkdown(highlights))
    } else if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv')
      res.setHeader('Content-Disposition', 'attachment; filename=my-highlights.csv')
      res.send(formatAsCSV(highlights))
    } else {
      res.setHeader('Content-Disposition', 'attachment; filename=my-highlights.json')
      res.json(highlights)
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
       WHERE h.user_id = $1 AND h.deleted_at IS NULL
       GROUP BY b.id
       ORDER BY last_highlighted DESC`,
      [userId]
    )

    res.json(result.rows)
  } catch (error) {
    next(error)
  }
})

/** A highlight joined with its book, as exported. */
interface ExportRow {
  book_id: string
  book_title: string
  book_author: string
  highlighted_text: string
  note: string | null
  color: string
  created_at: Date
}

/**
 * Format highlights as Markdown
 */
function formatAsMarkdown(highlights: ExportRow[]): string {
  const byBook: Record<string, { title: string; author: string; highlights: ExportRow[] }> = {}

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

/** Quotes a CSV field when it contains a delimiter, quote or newline. */
function csvField(value: string | null | undefined): string {
  const text = value ?? ''
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * Format highlights as CSV
 */
function formatAsCSV(highlights: ExportRow[]): string {
  const headers = ['Book Title', 'Author', 'Highlighted Text', 'Note', 'Color', 'Date']
  const rows = highlights.map((h) => [
    csvField(h.book_title),
    csvField(h.book_author),
    csvField(h.highlighted_text),
    csvField(h.note),
    csvField(h.color),
    new Date(h.created_at).toISOString(),
  ])

  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n')
}

/** Error handling middleware */
app.use(errorHandler(logger))
