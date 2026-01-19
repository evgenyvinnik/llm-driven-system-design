/**
 * Training job routes for the admin service.
 * Handles starting, listing, and cancelling training jobs.
 * @module admin/training
 */

import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { pool } from '../shared/db.js'
import { publishTrainingJob } from '../shared/queue.js'
import { createChildLogger, logError } from '../shared/logger.js'
import { rabbitCircuitBreaker, CircuitBreakerOpenError } from '../shared/circuitBreaker.js'
import { withRetry, RetryPresets } from '../shared/retry.js'
import { trainingJobsTotal, trackExternalCall } from '../shared/metrics.js'
import { requireAdmin } from './auth.js'

const router = Router()

/**
 * POST /api/admin/training/start - Starts a new model training job.
 *
 * @description Creates a training job record in the database and publishes
 *   it to RabbitMQ for async processing by the training worker.
 *   Uses circuit breaker and retry patterns for queue resilience.
 *
 * @route POST /api/admin/training/start
 *
 * @param {Request} req - Express request with optional body.config {object}
 *   containing training configuration (epochs, batch size, etc.)
 * @param {Response} res - Express response object
 *
 * @returns {object} 201 - Created job with ID and status
 * @returns {object} 503 - If RabbitMQ circuit breaker is open
 * @returns {object} 500 - If job creation fails
 *
 * @throws {CircuitBreakerOpenError} When RabbitMQ circuit breaker is open
 *
 * @example
 * // Request body
 * { "config": { "epochs": 10, "batchSize": 32, "learningRate": 0.001 } }
 *
 * // Success response (201)
 * { "id": "uuid", "status": "queued", "message": "Training job queued" }
 */
router.post('/start', requireAdmin, async (req: Request, res: Response) => {
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
        res.status(503).json({
          error: 'Queue temporarily unavailable',
          retryAfter: Math.ceil(error.retryAfterMs / 1000),
        })
        return
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
 *
 * @description Retrieves full details of a training job including configuration,
 *   status, timing, error messages, metrics, and model path if completed.
 *
 * @route GET /api/admin/training/:id
 *
 * @param {Request} req - Express request with params.id {string} - Training job UUID
 * @param {Response} res - Express response object
 *
 * @returns {object} 200 - Training job details
 * @returns {object} 404 - If training job not found
 * @returns {object} 500 - If fetching job fails
 *
 * @example
 * // Success response
 * {
 *   "id": "uuid",
 *   "status": "completed",
 *   "config": { "epochs": 10 },
 *   "error_message": null,
 *   "started_at": "2024-01-15T10:00:00Z",
 *   "completed_at": "2024-01-15T10:30:00Z",
 *   "metrics": { "accuracy": 0.95, "loss": 0.05 },
 *   "model_path": "models/v1.0/model.pt"
 * }
 */
router.get('/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params

    const result = await pool.query(
      `SELECT id, status, config, error_message, started_at, completed_at, metrics, model_path
       FROM training_jobs WHERE id = $1`,
      [id]
    )

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Training job not found' })
      return
    }

    res.json(result.rows[0])
  } catch (error) {
    logError(error as Error, { endpoint: '/api/admin/training/:id' })
    res.status(500).json({ error: 'Failed to fetch training job' })
  }
})

/**
 * GET /api/admin/training - Lists all training jobs (most recent first).
 *
 * @description Retrieves a list of training jobs ordered by creation date.
 *   Returns the most recent 50 jobs with summary information.
 *
 * @route GET /api/admin/training
 *
 * @param {Request} _req - Express request (unused, auth handled by middleware)
 * @param {Response} res - Express response object
 *
 * @returns {object[]} 200 - Array of training job summaries
 * @returns {object} 500 - If fetching jobs fails
 *
 * @example
 * // Success response
 * [
 *   {
 *     "id": "uuid",
 *     "status": "completed",
 *     "config": { "epochs": 10 },
 *     "started_at": "2024-01-15T10:00:00Z",
 *     "completed_at": "2024-01-15T10:30:00Z",
 *     "created_at": "2024-01-15T09:59:00Z",
 *     "progress": 100,
 *     "accuracy": "0.95",
 *     "error_message": null
 *   }
 * ]
 */
router.get('/', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT id, status, config, started_at, completed_at, created_at, progress,
             metrics->>'accuracy' as accuracy, error_message
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
 * POST /api/admin/training/:id/cancel - Cancels a training job.
 *
 * @description Cancels a training job by updating its status to 'cancelled'.
 *   Only jobs with status 'pending', 'queued', or 'running' can be cancelled.
 *   Sets the completed_at timestamp to the current time.
 *
 * @route POST /api/admin/training/:id/cancel
 *
 * @param {Request} req - Express request with params.id {string} - Training job UUID
 * @param {Response} res - Express response object
 *
 * @returns {object} 200 - Success response { success: true, message: string }
 * @returns {object} 400 - If job status doesn't allow cancellation
 * @returns {object} 404 - If training job not found
 * @returns {object} 500 - If cancellation fails
 *
 * @example
 * POST /api/admin/training/123e4567-e89b-12d3-a456-426614174000/cancel
 * // Success response
 * { "success": true, "message": "Training job cancelled" }
 *
 * // Error response (400)
 * { "error": "Cannot cancel job with status 'completed'" }
 */
router.post('/:id/cancel', requireAdmin, async (req: Request, res: Response) => {
  const reqLogger = createChildLogger({ endpoint: '/api/admin/training/:id/cancel' })

  try {
    const { id } = req.params

    // Check current status
    const result = await pool.query(
      'SELECT status FROM training_jobs WHERE id = $1',
      [id]
    )

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Training job not found' })
      return
    }

    const currentStatus = result.rows[0].status
    if (!['pending', 'queued', 'running'].includes(currentStatus)) {
      res.status(400).json({
        error: `Cannot cancel job with status '${currentStatus}'`,
      })
      return
    }

    // Update status to cancelled
    await pool.query(
      `UPDATE training_jobs
       SET status = 'cancelled', completed_at = NOW()
       WHERE id = $1`,
      [id]
    )

    reqLogger.info({ msg: 'Training job cancelled', jobId: id })
    res.json({ success: true, message: 'Training job cancelled' })
  } catch (error) {
    logError(error as Error, { endpoint: '/api/admin/training/:id/cancel' })
    res.status(500).json({ error: 'Failed to cancel training job' })
  }
})

export { router as trainingRouter }
