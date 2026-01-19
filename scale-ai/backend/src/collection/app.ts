/**
 * Collection service Express application.
 * Provides REST API endpoints for the drawing game:
 * - GET /api/shapes - List available shapes to draw
 * - POST /api/drawings - Submit a new drawing
 * - GET /api/user/stats - Get user's drawing statistics
 *
 * Enhanced with:
 * - Idempotency middleware to prevent duplicate submissions
 * - Circuit breakers for external service resilience
 * - Structured logging for debugging and alerting
 * - Prometheus metrics for observability
 * - Health checks for container orchestration
 *
 * @module collection/app
 */

import express from 'express'
import cors from 'cors'
import { pool } from '../shared/db.js'
import { uploadDrawing } from '../shared/storage.js'
import { cacheGet, cacheSet, cacheDelete, CacheKeys } from '../shared/cache.js'
import { v4 as uuidv4 } from 'uuid'

// New shared modules
import { logger, createChildLogger, logError } from '../shared/logger.js'
import { idempotencyMiddleware } from '../shared/idempotency.js'
import { minioCircuitBreaker, postgresCircuitBreaker, CircuitBreakerOpenError } from '../shared/circuitBreaker.js'
import { withRetry, RetryPresets } from '../shared/retry.js'
import { metricsMiddleware, metricsHandler, drawingsTotal, drawingProcessingDuration, trackExternalCall } from '../shared/metrics.js'
import { healthCheckRouter } from '../shared/healthCheck.js'

/** Express application instance */
export const app = express()

// Middleware
app.use(cors())
app.use(express.json({ limit: '1mb' }))

// Prometheus metrics middleware (must be before routes)
app.use(metricsMiddleware())

// Health check endpoints
app.use(healthCheckRouter())

// Prometheus metrics endpoint
app.get('/metrics', metricsHandler)

/**
 * GET /api/shapes - Returns list of available shapes.
 * Cached for 5 minutes since shapes rarely change.
 */
app.get('/api/shapes', async (req, res) => {
  const reqLogger = createChildLogger({
    requestId: req.headers['x-request-id'] || uuidv4(),
    endpoint: '/api/shapes',
  })

  try {
    // Check cache first
    const cacheKey = CacheKeys.shapes()
    const cached = await cacheGet<object[]>(cacheKey)
    if (cached) {
      reqLogger.debug({ msg: 'Returning cached shapes' })
      return res.json(cached)
    }

    // Query database with circuit breaker protection
    const result = await postgresCircuitBreaker.execute(async () => {
      return trackExternalCall('postgres', 'select_shapes', async () => {
        return pool.query(
          'SELECT id, name, description, difficulty FROM shapes ORDER BY difficulty, name'
        )
      })
    })

    // Cache for 5 minutes
    await cacheSet(cacheKey, result.rows, 300)

    reqLogger.info({ msg: 'Fetched shapes from database', count: result.rows.length })
    res.json(result.rows)
  } catch (error) {
    if (error instanceof CircuitBreakerOpenError) {
      reqLogger.warn({ msg: 'Database circuit breaker open', retryAfterMs: error.retryAfterMs })
      res.status(503).json({
        error: 'Service temporarily unavailable',
        retryAfter: Math.ceil(error.retryAfterMs / 1000),
      })
      return
    }

    logError(error as Error, { endpoint: '/api/shapes' })
    res.status(500).json({ error: 'Failed to fetch shapes' })
  }
})

/**
 * Shape of a drawing submission request body.
 */
interface DrawingSubmission {
  sessionId: string
  shape: string
  canvas: { width: number; height: number }
  strokes: Array<{
    points: Array<{ x: number; y: number; pressure: number; timestamp: number }>
    color: string
    width: number
  }>
  duration_ms: number
  device?: string
}

/**
 * POST /api/drawings - Submits a new drawing.
 * Creates user if not exists, validates shape, stores stroke data in MinIO,
 * and records metadata in PostgreSQL.
 *
 * Features:
 * - Idempotency: Duplicate submissions return cached response
 * - Circuit breakers: Fail fast when external services are down
 * - Retry logic: Automatic retries with exponential backoff
 * - Metrics: Tracks submission counts and processing duration
 */
app.post(
  '/api/drawings',
  // Idempotency middleware prevents duplicate submissions
  idempotencyMiddleware('drawing', {
    ttlSeconds: 3600, // 1 hour
    contextExtractor: (req) => req.body?.sessionId || 'anonymous',
  }),
  async (req, res) => {
    const startTime = Date.now()
    const requestId = req.headers['x-request-id'] || uuidv4()
    const reqLogger = createChildLogger({
      requestId,
      endpoint: '/api/drawings',
    })

    try {
      const submission: DrawingSubmission = req.body

      // Validate required fields
      if (!submission.sessionId || !submission.shape || !submission.strokes) {
        reqLogger.warn({ msg: 'Missing required fields', body: Object.keys(req.body) })
        drawingsTotal.labels(submission.shape || 'unknown', 'error').inc()
        return res.status(400).json({ error: 'Missing required fields' })
      }

      reqLogger.info({
        msg: 'Processing drawing submission',
        shape: submission.shape,
        strokeCount: submission.strokes.length,
        durationMs: submission.duration_ms,
      })

      // Get or create user with circuit breaker protection
      let userId: string
      try {
        const userIdResult = await postgresCircuitBreaker.execute(async () => {
          const retryResult = await withRetry(async () => {
            const userResult = await pool.query(
              'SELECT id FROM users WHERE session_id = $1',
              [submission.sessionId]
            )

            if (userResult.rows.length > 0) {
              return userResult.rows[0].id as string
            } else {
              const newUser = await pool.query(
                'INSERT INTO users (session_id) VALUES ($1) RETURNING id',
                [submission.sessionId]
              )
              return newUser.rows[0].id as string
            }
          }, RetryPresets.postgres)
          return retryResult.result
        })
        userId = userIdResult
      } catch (error) {
        if (error instanceof CircuitBreakerOpenError) {
          reqLogger.warn({ msg: 'Database circuit breaker open' })
          drawingsTotal.labels(submission.shape, 'error').inc()
          return res.status(503).json({
            error: 'Service temporarily unavailable',
            retryAfter: Math.ceil(error.retryAfterMs / 1000),
          })
        }
        throw error
      }

      // Get shape ID with circuit breaker
      const shapeResult = await postgresCircuitBreaker.execute(async () => {
        return trackExternalCall('postgres', 'select_shape', async () => {
          return pool.query('SELECT id FROM shapes WHERE name = $1', [submission.shape])
        })
      })

      if (shapeResult.rows.length === 0) {
        reqLogger.warn({ msg: 'Invalid shape', shape: submission.shape })
        drawingsTotal.labels(submission.shape, 'error').inc()
        return res.status(400).json({ error: 'Invalid shape' })
      }

      const shapeId = shapeResult.rows[0].id

      // Generate drawing ID and prepare stroke data
      const drawingId = uuidv4()
      const strokeData = {
        id: drawingId,
        shape: submission.shape,
        canvas: submission.canvas,
        strokes: submission.strokes,
        duration_ms: submission.duration_ms,
        device: submission.device || 'unknown',
        user_agent: req.get('user-agent') || 'unknown',
      }

      // Upload to MinIO with circuit breaker and retry
      let objectPath: string
      try {
        const uploadResult = await minioCircuitBreaker.execute(async () => {
          const retryResult = await withRetry(
            async () => {
              return trackExternalCall('minio', 'putObject', async () => {
                return uploadDrawing(drawingId, strokeData)
              })
            },
            { ...RetryPresets.minio, operationName: 'minio-upload' }
          )
          return retryResult.result
        })
        objectPath = uploadResult
      } catch (error) {
        if (error instanceof CircuitBreakerOpenError) {
          reqLogger.warn({ msg: 'MinIO circuit breaker open' })
          drawingsTotal.labels(submission.shape, 'error').inc()
          return res.status(503).json({
            error: 'Storage temporarily unavailable',
            retryAfter: Math.ceil(error.retryAfterMs / 1000),
          })
        }
        throw error
      }

      // Calculate metadata
      const metadata = {
        canvas_width: submission.canvas.width,
        canvas_height: submission.canvas.height,
        stroke_count: submission.strokes.length,
        point_count: submission.strokes.reduce((sum, s) => sum + s.points.length, 0),
        duration_ms: submission.duration_ms,
        device: submission.device || 'unknown',
      }

      // Insert drawing record with retry
      await postgresCircuitBreaker.execute(async () => {
        return await withRetry(
          async () => {
            return trackExternalCall('postgres', 'insert_drawing', async () => {
              return pool.query(
                `INSERT INTO drawings (id, user_id, shape_id, stroke_data_path, metadata)
                 VALUES ($1, $2, $3, $4, $5)`,
                [drawingId, userId, shapeId, objectPath, JSON.stringify(metadata)]
              )
            })
          },
          RetryPresets.postgres
        )
      })

      // Increment user's drawing count (best effort, don't fail if this fails)
      try {
        await pool.query(
          'UPDATE users SET total_drawings = total_drawings + 1, updated_at = NOW() WHERE id = $1',
          [userId]
        )
      } catch (err) {
        reqLogger.warn({
          msg: 'Failed to update user drawing count',
          error: (err as Error).message,
        })
      }

      // Invalidate caches (best effort)
      await cacheDelete(CacheKeys.adminStats()).catch(() => {})
      await cacheDelete(CacheKeys.userStats(submission.sessionId)).catch(() => {})

      // Record success metrics
      const processingTime = (Date.now() - startTime) / 1000
      drawingsTotal.labels(submission.shape, 'success').inc()
      drawingProcessingDuration.labels(submission.shape).observe(processingTime)

      reqLogger.info({
        msg: 'Drawing saved successfully',
        drawingId,
        shape: submission.shape,
        processingTimeMs: Date.now() - startTime,
      })

      res.status(201).json({
        id: drawingId,
        message: 'Drawing saved successfully',
      })
    } catch (error) {
      const submission = req.body as DrawingSubmission
      drawingsTotal.labels(submission?.shape || 'unknown', 'error').inc()
      logError(error as Error, { endpoint: '/api/drawings', requestId })
      res.status(500).json({ error: 'Failed to save drawing' })
    }
  }
)

/**
 * GET /api/user/stats - Returns user's drawing statistics.
 * Requires sessionId query parameter. Cached for 60 seconds.
 */
app.get('/api/user/stats', async (req, res) => {
  const reqLogger = createChildLogger({
    requestId: req.headers['x-request-id'] || uuidv4(),
    endpoint: '/api/user/stats',
  })

  try {
    const sessionId = req.query.sessionId as string

    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID required' })
    }

    // Check cache first
    const cacheKey = CacheKeys.userStats(sessionId)
    const cached = await cacheGet<object>(cacheKey)
    if (cached) {
      reqLogger.debug({ msg: 'Returning cached user stats' })
      return res.json(cached)
    }

    const result = await postgresCircuitBreaker.execute(async () => {
      return trackExternalCall('postgres', 'select_user_stats', async () => {
        return pool.query(
          `SELECT u.total_drawings,
                  (SELECT COUNT(*) FROM drawings d WHERE d.user_id = u.id AND d.created_at > NOW() - INTERVAL '1 day') as today_count
           FROM users u
           WHERE u.session_id = $1`,
          [sessionId]
        )
      })
    })

    const stats = result.rows.length === 0
      ? { total_drawings: 0, today_count: 0 }
      : {
          total_drawings: result.rows[0].total_drawings,
          today_count: parseInt(result.rows[0].today_count),
        }

    // Cache for 60 seconds
    await cacheSet(cacheKey, stats, 60)

    reqLogger.debug({ msg: 'Fetched user stats', sessionId: sessionId.substring(0, 8) + '...' })
    res.json(stats)
  } catch (error) {
    if (error instanceof CircuitBreakerOpenError) {
      return res.status(503).json({
        error: 'Service temporarily unavailable',
        retryAfter: Math.ceil(error.retryAfterMs / 1000),
      })
    }

    logError(error as Error, { endpoint: '/api/user/stats' })
    res.status(500).json({ error: 'Failed to fetch stats' })
  }
})
