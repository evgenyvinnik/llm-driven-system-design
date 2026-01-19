/**
 * Drawing management routes for the admin service.
 * Handles listing, flagging, deleting, and restoring drawings.
 * @module admin/drawings
 */

import { Router, Request, Response } from 'express'
import { pool } from '../shared/db.js'
import { getDrawing } from '../shared/storage.js'
import { cacheDelete, CacheKeys } from '../shared/cache.js'
import { logger, logError } from '../shared/logger.js'
import { minioCircuitBreaker, CircuitBreakerOpenError } from '../shared/circuitBreaker.js'
import { trackExternalCall } from '../shared/metrics.js'
import { scoreDrawing, type StrokeData } from '../shared/quality.js'
import { requireAdmin } from './auth.js'

const router = Router()

/**
 * GET /api/admin/drawings - Lists drawings with pagination and filters.
 *
 * @description Retrieves a paginated list of drawings with optional filtering.
 *   Supports filtering by shape name, flagged status, date range, and whether
 *   to include soft-deleted items. Results are ordered by creation date (newest first).
 *
 * @route GET /api/admin/drawings
 *
 * @param {Request} req - Express request with query parameters:
 *   - page {number} [default=1] - Page number for pagination
 *   - limit {number} [default=20, max=100] - Items per page
 *   - shape {string} [optional] - Filter by shape name
 *   - flagged {string} [optional] - Set to 'true' to show only flagged drawings
 *   - includeDeleted {string} [optional] - Set to 'true' to include soft-deleted
 *   - startDate {string} [optional] - Filter drawings created on or after this date
 *   - endDate {string} [optional] - Filter drawings created before this date
 * @param {Response} res - Express response object
 *
 * @returns {object} 200 - Paginated drawings list with metadata
 * @returns {object} 500 - If database query fails
 *
 * @example
 * // GET /api/admin/drawings?shape=circle&flagged=true&page=2&limit=10
 * // Success response
 * {
 *   "drawings": [{ "id": "uuid", "shape": "circle", "is_flagged": true, ... }],
 *   "pagination": { "page": 2, "limit": 10, "total": 45, "pages": 5 }
 * }
 */
router.get('/', requireAdmin, async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
    const offset = (page - 1) * limit
    const shape = req.query.shape as string
    const flagged = req.query.flagged === 'true'
    const includeDeleted = req.query.includeDeleted === 'true'
    const startDate = req.query.startDate as string
    const endDate = req.query.endDate as string

    let whereClause = 'WHERE 1=1'
    const params: (string | boolean | number)[] = []

    // Exclude soft-deleted drawings by default
    if (!includeDeleted) {
      whereClause += ' AND d.deleted_at IS NULL'
    }

    if (shape) {
      params.push(shape)
      whereClause += ` AND s.name = $${params.length}`
    }

    if (flagged) {
      whereClause += ' AND d.is_flagged = TRUE'
    }

    // Date range filter
    if (startDate) {
      params.push(startDate)
      whereClause += ` AND d.created_at >= $${params.length}::date`
    }

    if (endDate) {
      params.push(endDate)
      whereClause += ` AND d.created_at < ($${params.length}::date + interval '1 day')`
    }

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as count
      FROM drawings d
      JOIN shapes s ON d.shape_id = s.id
      ${whereClause}
    `
    const countResult = await pool.query(countQuery, params)
    const total = parseInt(countResult.rows[0].count)

    // Get drawings
    params.push(limit, offset)
    const query = `
      SELECT d.id, d.stroke_data_path, d.metadata, d.quality_score,
             d.is_flagged, d.deleted_at, d.created_at, s.name as shape
      FROM drawings d
      JOIN shapes s ON d.shape_id = s.id
      ${whereClause}
      ORDER BY d.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `

    const result = await pool.query(query, params)

    res.json({
      drawings: result.rows,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    })
  } catch (error) {
    logError(error as Error, { endpoint: '/api/admin/drawings' })
    res.status(500).json({ error: 'Failed to fetch drawings' })
  }
})

/**
 * POST /api/admin/drawings/:id/flag - Flags or unflags a drawing.
 *
 * @description Toggles the flagged status of a drawing. Flagged drawings can be
 *   excluded from training data to improve model quality. Invalidates the admin
 *   stats cache to reflect the updated flagged count.
 *
 * @route POST /api/admin/drawings/:id/flag
 *
 * @param {Request} req - Express request with:
 *   - params.id {string} - Drawing UUID to flag/unflag
 *   - body.flagged {boolean} [default=true] - Set to false to unflag
 * @param {Response} res - Express response object
 *
 * @returns {object} 200 - Success response { success: true }
 * @returns {object} 500 - If database update fails
 *
 * @example
 * // Flag a drawing
 * POST /api/admin/drawings/123e4567-e89b-12d3-a456-426614174000/flag
 * { "flagged": true }
 */
router.post('/:id/flag', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const { flagged } = req.body

    await pool.query(
      'UPDATE drawings SET is_flagged = $1 WHERE id = $2',
      [flagged !== false, id]
    )

    // Invalidate stats cache since flagged count changed
    await cacheDelete(CacheKeys.adminStats())

    logger.info({ msg: 'Drawing flagged', drawingId: id, flagged: flagged !== false })
    res.json({ success: true })
  } catch (error) {
    logError(error as Error, { endpoint: '/api/admin/drawings/:id/flag' })
    res.status(500).json({ error: 'Failed to flag drawing' })
  }
})

/**
 * DELETE /api/admin/drawings/:id - Soft-deletes a drawing.
 *
 * @description Performs a soft delete by setting the deleted_at timestamp.
 *   The drawing remains in the database and can be restored later.
 *   Soft-deleted drawings are excluded from default listing and training data.
 *   Invalidates the admin stats cache.
 *
 * @route DELETE /api/admin/drawings/:id
 *
 * @param {Request} req - Express request with params.id {string} - Drawing UUID
 * @param {Response} res - Express response object
 *
 * @returns {object} 200 - Success response { success: true }
 * @returns {object} 500 - If database update fails
 *
 * @example
 * DELETE /api/admin/drawings/123e4567-e89b-12d3-a456-426614174000
 * // Response: { "success": true }
 */
router.delete('/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params

    await pool.query(
      'UPDATE drawings SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL',
      [id]
    )

    // Invalidate stats cache
    await cacheDelete(CacheKeys.adminStats())

    logger.info({ msg: 'Drawing soft-deleted', drawingId: id })
    res.json({ success: true })
  } catch (error) {
    logError(error as Error, { endpoint: '/api/admin/drawings/:id' })
    res.status(500).json({ error: 'Failed to delete drawing' })
  }
})

/**
 * POST /api/admin/drawings/:id/restore - Restores a soft-deleted drawing.
 *
 * @description Reverses a soft delete by clearing the deleted_at timestamp.
 *   The drawing will appear in default listings and be available for training.
 *   Invalidates the admin stats cache.
 *
 * @route POST /api/admin/drawings/:id/restore
 *
 * @param {Request} req - Express request with params.id {string} - Drawing UUID
 * @param {Response} res - Express response object
 *
 * @returns {object} 200 - Success response { success: true }
 * @returns {object} 500 - If database update fails
 *
 * @example
 * POST /api/admin/drawings/123e4567-e89b-12d3-a456-426614174000/restore
 * // Response: { "success": true }
 */
router.post('/:id/restore', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params

    await pool.query(
      'UPDATE drawings SET deleted_at = NULL WHERE id = $1',
      [id]
    )

    // Invalidate stats cache
    await cacheDelete(CacheKeys.adminStats())

    logger.info({ msg: 'Drawing restored', drawingId: id })
    res.json({ success: true })
  } catch (error) {
    logError(error as Error, { endpoint: '/api/admin/drawings/:id/restore' })
    res.status(500).json({ error: 'Failed to restore drawing' })
  }
})

/**
 * GET /api/admin/drawings/:id/strokes - Returns the raw stroke data for a drawing.
 *
 * @description Fetches the stroke data JSON from MinIO object storage.
 *   Stroke data contains the raw drawing points with timestamps and pressure.
 *   Uses circuit breaker pattern for MinIO resilience.
 *
 * @route GET /api/admin/drawings/:id/strokes
 *
 * @param {Request} req - Express request with params.id {string} - Drawing UUID
 * @param {Response} res - Express response object
 *
 * @returns {object} 200 - Stroke data JSON (format varies by drawing)
 * @returns {object} 404 - If drawing not found
 * @returns {object} 503 - If MinIO circuit breaker is open
 * @returns {object} 500 - If fetching stroke data fails
 *
 * @throws {CircuitBreakerOpenError} When MinIO circuit breaker is open
 *
 * @example
 * // Success response
 * {
 *   "strokes": [[{"x": 10, "y": 20, "t": 0}, {"x": 15, "y": 25, "t": 16}]],
 *   "width": 400,
 *   "height": 400
 * }
 */
router.get('/:id/strokes', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params

    // Get the stroke data path from the database
    const result = await pool.query(
      'SELECT stroke_data_path FROM drawings WHERE id = $1',
      [id]
    )

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Drawing not found' })
      return
    }

    const strokeDataPath = result.rows[0].stroke_data_path

    // Fetch from MinIO with circuit breaker
    const strokeData = await minioCircuitBreaker.execute(async () => {
      return trackExternalCall('minio', 'getObject', async () => {
        return getDrawing(strokeDataPath)
      })
    })

    res.json(strokeData)
  } catch (error) {
    if (error instanceof CircuitBreakerOpenError) {
      res.status(503).json({
        error: 'Storage temporarily unavailable',
        retryAfter: Math.ceil(error.retryAfterMs / 1000),
      })
      return
    }

    logError(error as Error, { endpoint: '/api/admin/drawings/:id/strokes' })
    res.status(500).json({ error: 'Failed to fetch stroke data' })
  }
})

/**
 * GET /api/admin/drawings/:id/quality - Analyzes quality of a single drawing.
 *
 * @description Fetches the drawing's stroke data and runs quality analysis.
 *   Returns a detailed quality score with individual check results for
 *   stroke count, point density, drawing speed, and canvas coverage.
 *
 * @route GET /api/admin/drawings/:id/quality
 *
 * @param {Request} req - Express request with params.id {string} - Drawing UUID
 * @param {Response} res - Express response object
 *
 * @returns {object} 200 - Quality analysis results
 * @returns {object} 404 - If drawing not found
 * @returns {object} 500 - If analysis fails
 *
 * @example
 * // Success response
 * {
 *   "drawingId": "uuid",
 *   "quality": {
 *     "score": 75,
 *     "passed": true,
 *     "recommendation": "Good quality drawing",
 *     "checks": {
 *       "strokeCount": { "passed": true, "value": 5 },
 *       "pointDensity": { "passed": true, "value": 150 }
 *     }
 *   }
 * }
 */
router.get('/:id/quality', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params

    // Get the stroke data path from the database
    const result = await pool.query(
      'SELECT stroke_data_path FROM drawings WHERE id = $1',
      [id]
    )

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Drawing not found' })
      return
    }

    const strokeDataPath = result.rows[0].stroke_data_path

    // Fetch from MinIO
    const strokeData = await getDrawing(strokeDataPath) as StrokeData

    // Score the drawing
    const quality = scoreDrawing(strokeData)

    res.json({
      drawingId: id,
      quality,
    })
  } catch (error) {
    logError(error as Error, { endpoint: '/api/admin/drawings/:id/quality' })
    res.status(500).json({ error: 'Failed to analyze drawing quality' })
  }
})

export { router as drawingsRouter }
