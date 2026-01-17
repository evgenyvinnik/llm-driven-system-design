/**
 * Admin service for data management and model training.
 * Provides REST API endpoints for administrators to:
 * - View dashboard statistics
 * - Browse, flag, and delete drawings
 * - Analyze data quality
 * - Start training jobs and manage models
 * Requires session-based authentication.
 *
 * Enhanced with:
 * - Structured JSON logging for debugging and alerting
 * - Prometheus metrics for observability
 * - Health checks for container orchestration
 * - Circuit breakers for external service resilience
 *
 * @module admin
 */

import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import { pool } from '../shared/db.js'
import { publishTrainingJob } from '../shared/queue.js'
import { getDrawing } from '../shared/storage.js'
import { cacheGet, cacheSet, cacheDelete, CacheKeys } from '../shared/cache.js'
import { validateLogin, createSession, getSession, deleteSession } from '../shared/auth.js'
import { scoreDrawing, type StrokeData } from '../shared/quality.js'
import { v4 as uuidv4 } from 'uuid'

// New shared modules
import { logger, createChildLogger, logError } from '../shared/logger.js'
import { postgresCircuitBreaker, rabbitCircuitBreaker, minioCircuitBreaker, CircuitBreakerOpenError } from '../shared/circuitBreaker.js'
import { withRetry, RetryPresets } from '../shared/retry.js'
import { metricsMiddleware, metricsHandler, trainingJobsTotal, trackExternalCall } from '../shared/metrics.js'
import { healthCheckRouter } from '../shared/healthCheck.js'
import { runAllCleanupJobs, LifecycleConfig } from '../shared/cleanup.js'

const app = express()

/** Port for the admin service (default: 3002) */
const PORT = parseInt(process.env.PORT || '3002')

// Set service name for logging
process.env.SERVICE_NAME = 'admin'

/**
 * Session data attached to authenticated requests.
 */
interface AdminSession {
  userId: string
  email: string
  name: string | null
}

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      adminSession?: AdminSession
    }
  }
}

// Middleware configuration
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}))
app.use(express.json())
app.use(cookieParser())

// Prometheus metrics middleware (must be before routes)
app.use(metricsMiddleware())

// Health check endpoints
app.use(healthCheckRouter())

// Prometheus metrics endpoint
app.get('/metrics', metricsHandler)

/**
 * Authentication middleware that verifies the admin session cookie.
 * Attaches session data to req.adminSession on success.
 * Returns 401 if not authenticated or session expired.
 */
async function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const sessionId = req.cookies.adminSession

  if (!sessionId) {
    return res.status(401).json({ error: 'Not authenticated' })
  }

  const session = await getSession(sessionId)
  if (!session) {
    return res.status(401).json({ error: 'Session expired' })
  }

  // Attach session to request
  req.adminSession = {
    userId: session.userId,
    email: session.email,
    name: session.name,
  }

  next()
}

/**
 * POST /api/admin/auth/login - Authenticates an admin user.
 * Creates a session and sets an httpOnly cookie.
 */
app.post('/api/admin/auth/login', async (req, res) => {
  const reqLogger = createChildLogger({ endpoint: '/api/admin/auth/login' })

  try {
    const { email, password, rememberMe } = req.body

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' })
    }

    const user = await validateLogin(email, password)
    if (!user) {
      reqLogger.warn({ msg: 'Invalid login attempt', email })
      return res.status(401).json({ error: 'Invalid credentials' })
    }

    const { sessionId, ttl } = await createSession(user.id, user.email, user.name, rememberMe)

    res.cookie('adminSession', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: ttl * 1000, // Convert seconds to milliseconds
    })

    reqLogger.info({ msg: 'Admin login successful', email })

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    })
  } catch (error) {
    logError(error as Error, { endpoint: '/api/admin/auth/login' })
    res.status(500).json({ error: 'Login failed' })
  }
})

/**
 * POST /api/admin/auth/logout - Logs out the current admin user.
 * Clears the session from Redis and removes the cookie.
 */
app.post('/api/admin/auth/logout', async (req, res) => {
  const sessionId = req.cookies.adminSession

  if (sessionId) {
    await deleteSession(sessionId)
    logger.info({ msg: 'Admin logout', sessionId: sessionId.substring(0, 8) + '...' })
  }

  res.clearCookie('adminSession')
  res.json({ success: true })
})

/**
 * GET /api/admin/auth/me - Returns the current authenticated user.
 */
app.get('/api/admin/auth/me', requireAdmin, (req, res) => {
  res.json({ user: req.adminSession })
})

/**
 * GET /api/admin/stats - Returns aggregated dashboard statistics.
 * Includes total drawings, users, flagged count, per-shape breakdown,
 * active model info, and recent training jobs. Cached for 30 seconds.
 */
app.get('/api/admin/stats', requireAdmin, async (_req, res) => {
  const reqLogger = createChildLogger({ endpoint: '/api/admin/stats' })

  try {
    // Check cache first
    const cacheKey = CacheKeys.adminStats()
    const cached = await cacheGet<object>(cacheKey)
    if (cached) {
      return res.json(cached)
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
      return res.status(503).json({
        error: 'Service temporarily unavailable',
        retryAfter: Math.ceil(error.retryAfterMs / 1000),
      })
    }

    logError(error as Error, { endpoint: '/api/admin/stats' })
    res.status(500).json({ error: 'Failed to fetch stats' })
  }
})

/**
 * GET /api/admin/drawings - Lists drawings with pagination and filters.
 * Supports filtering by shape, date range, flagged status, and soft-deleted items.
 */
app.get('/api/admin/drawings', requireAdmin, async (req, res) => {
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
 * Flagged drawings can be excluded from training data.
 */
app.post('/api/admin/drawings/:id/flag', requireAdmin, async (req, res) => {
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
 * Sets deleted_at timestamp; drawing can be restored later.
 */
app.delete('/api/admin/drawings/:id', requireAdmin, async (req, res) => {
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
 * Clears the deleted_at timestamp.
 */
app.post('/api/admin/drawings/:id/restore', requireAdmin, async (req, res) => {
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
 * Fetches from MinIO object storage.
 */
app.get('/api/admin/drawings/:id/strokes', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params

    // Get the stroke data path from the database
    const result = await pool.query(
      'SELECT stroke_data_path FROM drawings WHERE id = $1',
      [id]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Drawing not found' })
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
      return res.status(503).json({
        error: 'Storage temporarily unavailable',
        retryAfter: Math.ceil(error.retryAfterMs / 1000),
      })
    }

    logError(error as Error, { endpoint: '/api/admin/drawings/:id/strokes' })
    res.status(500).json({ error: 'Failed to fetch stroke data' })
  }
})

/**
 * GET /api/admin/drawings/:id/quality - Analyzes quality of a single drawing.
 * Returns detailed quality score with individual check results.
 */
app.get('/api/admin/drawings/:id/quality', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params

    // Get the stroke data path from the database
    const result = await pool.query(
      'SELECT stroke_data_path FROM drawings WHERE id = $1',
      [id]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Drawing not found' })
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

/**
 * POST /api/admin/quality/analyze-batch - Batch analyzes quality of unscored drawings.
 * Can optionally update scores in database and auto-flag low quality drawings.
 * Use updateScores=false for dry run.
 */
app.post('/api/admin/quality/analyze-batch', requireAdmin, async (req, res) => {
  const reqLogger = createChildLogger({ endpoint: '/api/admin/quality/analyze-batch' })

  try {
    const { minScore, limit = 100, updateScores = false } = req.body

    // Fetch drawings that need quality analysis (null quality_score)
    const query = `
      SELECT d.id, d.stroke_data_path, s.name as shape
      FROM drawings d
      JOIN shapes s ON d.shape_id = s.id
      WHERE d.quality_score IS NULL AND d.deleted_at IS NULL
      LIMIT $1
    `
    const result = await pool.query(query, [limit])

    const analyzed: {
      id: string
      shape: string
      score: number
      passed: boolean
      recommendation: string
    }[] = []

    const failed: { id: string; error: string }[] = []

    for (const drawing of result.rows) {
      try {
        // Fetch stroke data
        const strokeData = await getDrawing(drawing.stroke_data_path) as StrokeData

        // Score the drawing
        const quality = scoreDrawing(strokeData)

        analyzed.push({
          id: drawing.id,
          shape: drawing.shape,
          score: quality.score,
          passed: quality.passed,
          recommendation: quality.recommendation,
        })

        // Update quality score in database if requested
        if (updateScores) {
          await pool.query(
            'UPDATE drawings SET quality_score = $1 WHERE id = $2',
            [quality.score, drawing.id]
          )
        }
      } catch (error) {
        failed.push({
          id: drawing.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      }
    }

    // Compute summary statistics
    const passedCount = analyzed.filter((d) => d.passed).length
    const avgScore = analyzed.length > 0
      ? analyzed.reduce((sum, d) => sum + d.score, 0) / analyzed.length
      : 0

    // If minScore is provided, auto-flag low quality drawings
    let flaggedCount = 0
    if (minScore !== undefined && updateScores) {
      const lowQuality = analyzed.filter((d) => d.score < minScore)
      for (const drawing of lowQuality) {
        await pool.query(
          'UPDATE drawings SET is_flagged = TRUE WHERE id = $1',
          [drawing.id]
        )
        flaggedCount++
      }
      if (flaggedCount > 0) {
        await cacheDelete(CacheKeys.adminStats())
      }
    }

    reqLogger.info({
      msg: 'Batch quality analysis complete',
      analyzed: analyzed.length,
      failed: failed.length,
      flagged: flaggedCount,
    })

    res.json({
      analyzed: analyzed.length,
      failed: failed.length,
      passed: passedCount,
      avgScore: Math.round(avgScore * 10) / 10,
      flagged: flaggedCount,
      results: analyzed,
      errors: failed,
      message: updateScores
        ? `Analyzed ${analyzed.length} drawings, updated scores${flaggedCount > 0 ? `, flagged ${flaggedCount} low quality` : ''}`
        : `Analyzed ${analyzed.length} drawings (dry run, scores not saved)`,
    })
  } catch (error) {
    logError(error as Error, { endpoint: '/api/admin/quality/analyze-batch' })
    res.status(500).json({ error: 'Failed to analyze drawings' })
  }
})

/**
 * GET /api/admin/quality/stats - Returns quality score statistics.
 * Shows distribution across quality tiers and average scores per shape.
 */
app.get('/api/admin/quality/stats', requireAdmin, async (_req, res) => {
  try {
    // Overall quality score distribution
    const distribution = await pool.query(`
      SELECT
        CASE
          WHEN quality_score >= 70 THEN 'high'
          WHEN quality_score >= 50 THEN 'medium'
          WHEN quality_score IS NOT NULL THEN 'low'
          ELSE 'unscored'
        END as quality_tier,
        COUNT(*) as count
      FROM drawings
      WHERE deleted_at IS NULL
      GROUP BY quality_tier
    `)

    // Average score per shape
    const perShape = await pool.query(`
      SELECT s.name as shape, AVG(d.quality_score) as avg_score, COUNT(d.id) as count
      FROM drawings d
      JOIN shapes s ON d.shape_id = s.id
      WHERE d.quality_score IS NOT NULL AND d.deleted_at IS NULL
      GROUP BY s.name
      ORDER BY s.name
    `)

    // Unscored count
    const unscored = await pool.query(`
      SELECT COUNT(*) as count
      FROM drawings
      WHERE quality_score IS NULL AND deleted_at IS NULL
    `)

    res.json({
      distribution: distribution.rows,
      perShape: perShape.rows.map((r) => ({
        shape: r.shape,
        avgScore: r.avg_score ? Math.round(parseFloat(r.avg_score) * 10) / 10 : null,
        count: parseInt(r.count),
      })),
      unscoredCount: parseInt(unscored.rows[0].count),
    })
  } catch (error) {
    logError(error as Error, { endpoint: '/api/admin/quality/stats' })
    res.status(500).json({ error: 'Failed to fetch quality statistics' })
  }
})

/**
 * POST /api/admin/training/start - Starts a new model training job.
 * Creates a job record and publishes to RabbitMQ for async processing.
 */
app.post('/api/admin/training/start', requireAdmin, async (req, res) => {
  const reqLogger = createChildLogger({ endpoint: '/api/admin/training/start' })

  try {
    const config = req.body.config || {}

    // Create training job record
    const jobId = uuidv4()
    await pool.query(
      `INSERT INTO training_jobs (id, status, config)
       VALUES ($1, 'queued', $2)`,
      [jobId, JSON.stringify(config)]
    )

    // Publish to queue with circuit breaker and retry
    try {
      await rabbitCircuitBreaker.execute(async () => {
        return await withRetry(
          async () => {
            return trackExternalCall('rabbitmq', 'publish', async () => {
              return publishTrainingJob(jobId, config)
            })
          },
          RetryPresets.rabbitmq
        )
      })
    } catch (error) {
      // If queue fails, update job status to 'failed'
      await pool.query(
        `UPDATE training_jobs SET status = 'failed', error_message = $1 WHERE id = $2`,
        ['Failed to queue job: ' + (error instanceof Error ? error.message : String(error)), jobId]
      )

      if (error instanceof CircuitBreakerOpenError) {
        reqLogger.warn({ msg: 'RabbitMQ circuit breaker open' })
        return res.status(503).json({
          error: 'Queue temporarily unavailable',
          retryAfter: Math.ceil(error.retryAfterMs / 1000),
        })
      }
      throw error
    }

    // Record metric
    trainingJobsTotal.labels('queued').inc()

    reqLogger.info({ msg: 'Training job queued', jobId })

    res.status(201).json({
      id: jobId,
      status: 'queued',
      message: 'Training job queued',
    })
  } catch (error) {
    logError(error as Error, { endpoint: '/api/admin/training/start' })
    res.status(500).json({ error: 'Failed to start training job' })
  }
})

/**
 * GET /api/admin/training/:id - Returns status and details of a training job.
 */
app.get('/api/admin/training/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params

    const result = await pool.query(
      `SELECT id, status, config, error_message, started_at, completed_at, metrics, model_path
       FROM training_jobs WHERE id = $1`,
      [id]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Training job not found' })
    }

    res.json(result.rows[0])
  } catch (error) {
    logError(error as Error, { endpoint: '/api/admin/training/:id' })
    res.status(500).json({ error: 'Failed to fetch training job' })
  }
})

/**
 * GET /api/admin/training - Lists all training jobs (most recent first).
 */
app.get('/api/admin/training', requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, status, config, started_at, completed_at,
             metrics->>'accuracy' as accuracy
      FROM training_jobs
      ORDER BY created_at DESC
      LIMIT 50
    `)

    res.json(result.rows)
  } catch (error) {
    logError(error as Error, { endpoint: '/api/admin/training' })
    res.status(500).json({ error: 'Failed to fetch training jobs' })
  }
})

/**
 * GET /api/admin/models - Lists all trained models.
 */
app.get('/api/admin/models', requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.id, m.version, m.is_active, m.accuracy, m.model_path, m.created_at,
             tj.config as training_config
      FROM models m
      LEFT JOIN training_jobs tj ON m.training_job_id = tj.id
      ORDER BY m.created_at DESC
    `)

    res.json(result.rows)
  } catch (error) {
    logError(error as Error, { endpoint: '/api/admin/models' })
    res.status(500).json({ error: 'Failed to fetch models' })
  }
})

/**
 * POST /api/admin/models/:id/activate - Activates a model for inference.
 * Deactivates all other models first (only one active at a time).
 */
app.post('/api/admin/models/:id/activate', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params

    // Deactivate all models first
    await pool.query('UPDATE models SET is_active = FALSE')

    // Activate the selected model
    await pool.query('UPDATE models SET is_active = TRUE WHERE id = $1', [id])

    logger.info({ msg: 'Model activated', modelId: id })
    res.json({ success: true, message: 'Model activated' })
  } catch (error) {
    logError(error as Error, { endpoint: '/api/admin/models/:id/activate' })
    res.status(500).json({ error: 'Failed to activate model' })
  }
})

/**
 * POST /api/admin/cleanup/run - Manually triggers cleanup jobs.
 * Runs soft-delete cleanup, flagged archival, and orphan detection.
 */
app.post('/api/admin/cleanup/run', requireAdmin, async (req, res) => {
  const reqLogger = createChildLogger({ endpoint: '/api/admin/cleanup/run' })

  try {
    const config: Partial<LifecycleConfig> = {
      dryRun: req.body.dryRun ?? false,
      batchSize: req.body.batchSize ?? 100,
    }

    reqLogger.info({ msg: 'Starting manual cleanup', config })

    const results = await runAllCleanupJobs(config)

    const totalDeleted = results.reduce((sum, r) => sum + r.deletedCount, 0)
    const totalErrors = results.reduce((sum, r) => sum + r.errorCount, 0)

    res.json({
      success: true,
      totalDeleted,
      totalErrors,
      results,
    })
  } catch (error) {
    logError(error as Error, { endpoint: '/api/admin/cleanup/run' })
    res.status(500).json({ error: 'Failed to run cleanup jobs' })
  }
})

// Start server
app.listen(PORT, () => {
  logger.info({
    msg: 'Admin service started',
    port: PORT,
    env: process.env.NODE_ENV || 'development',
  })
})
