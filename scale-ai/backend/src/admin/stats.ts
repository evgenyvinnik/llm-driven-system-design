/**
 * Dashboard statistics routes for the admin service.
 * Provides aggregated data for admin dashboard display.
 * @module admin/stats
 */

import { Router, Request, Response } from 'express'
import { pool } from '../shared/db.js'
import { cacheGet, cacheSet, CacheKeys } from '../shared/cache.js'
import { createChildLogger, logError } from '../shared/logger.js'
import { postgresCircuitBreaker, CircuitBreakerOpenError } from '../shared/circuitBreaker.js'
import { requireAdmin } from './auth.js'

const router = Router()

/**
 * GET /api/admin/stats - Returns aggregated dashboard statistics.
 *
 * @description Fetches comprehensive statistics for the admin dashboard including:
 *   - Total drawing count and per-shape breakdown
 *   - Flagged and today's drawing counts
 *   - Total user count
 *   - Active model information
 *   - Recent training jobs (last 5)
 *
 *   Results are cached in Redis for 30 seconds to reduce database load.
 *   Uses circuit breaker pattern for PostgreSQL resilience.
 *
 * @route GET /api/admin/stats
 *
 * @param {Request} _req - Express request (unused, auth handled by middleware)
 * @param {Response} res - Express response object
 *
 * @returns {object} 200 - Dashboard statistics object
 * @returns {object} 503 - If database circuit breaker is open
 * @returns {object} 500 - If stats fetching fails
 *
 * @throws {CircuitBreakerOpenError} When PostgreSQL circuit breaker is open
 *
 * @example
 * // Success response
 * {
 *   "total_drawings": 1234,
 *   "drawings_per_shape": [{ "name": "circle", "count": "456" }],
 *   "flagged_count": 12,
 *   "today_count": 89,
 *   "total_users": 567,
 *   "active_model": { "id": "uuid", "version": "v1.0", "accuracy": 0.95 },
 *   "recent_jobs": [{ "id": "uuid", "status": "completed", "accuracy": "0.95" }]
 * }
 */
router.get('/', requireAdmin, async (_req: Request, res: Response) => {
  const reqLogger = createChildLogger({ endpoint: '/api/admin/stats' })

  try {
    // Check cache first
    const cacheKey = CacheKeys.adminStats()
    const cached = await cacheGet<object>(cacheKey)
    if (cached) {
      res.json(cached)
      return
    }

    // Query database with circuit breaker protection
    const stats = await postgresCircuitBreaker.execute(async () => {
      // Total drawings
      const totalDrawings = await pool.query('SELECT COUNT(*) as count FROM drawings')

      // Drawings per shape
      const perShape = await pool.query(`
        SELECT s.name, COUNT(d.id) as count
        FROM shapes s
        LEFT JOIN drawings d ON d.shape_id = s.id
        GROUP BY s.id, s.name
        ORDER BY s.name
      `)

      // Flagged drawings
      const flagged = await pool.query(
        'SELECT COUNT(*) as count FROM drawings WHERE is_flagged = TRUE'
      )

      // Today's drawings
      const today = await pool.query(`
        SELECT COUNT(*) as count FROM drawings
        WHERE created_at > NOW() - INTERVAL '1 day'
      `)

      // Total users
      const totalUsers = await pool.query('SELECT COUNT(*) as count FROM users')

      // Active model
      const activeModel = await pool.query(`
        SELECT id, version, accuracy, created_at
        FROM models WHERE is_active = TRUE
      `)

      // Recent training jobs
      const recentJobs = await pool.query(`
        SELECT id, status, created_at, completed_at,
               metrics->>'accuracy' as accuracy
        FROM training_jobs
        ORDER BY created_at DESC
        LIMIT 5
      `)

      return {
        total_drawings: parseInt(totalDrawings.rows[0].count),
        drawings_per_shape: perShape.rows,
        flagged_count: parseInt(flagged.rows[0].count),
        today_count: parseInt(today.rows[0].count),
        total_users: parseInt(totalUsers.rows[0].count),
        active_model: activeModel.rows[0] || null,
        recent_jobs: recentJobs.rows,
      }
    })

    // Cache for 30 seconds
    await cacheSet(cacheKey, stats, 30)

    reqLogger.debug({ msg: 'Fetched admin stats', totalDrawings: stats.total_drawings })
    res.json(stats)
  } catch (error) {
    if (error instanceof CircuitBreakerOpenError) {
      res.status(503).json({
        error: 'Service temporarily unavailable',
        retryAfter: Math.ceil(error.retryAfterMs / 1000),
      })
      return
    }

    logError(error as Error, { endpoint: '/api/admin/stats' })
    res.status(500).json({ error: 'Failed to fetch stats' })
  }
})

export { router as statsRouter }
