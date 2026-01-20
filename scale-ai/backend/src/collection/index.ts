/**
 * Collection service entry point.
 * Handles drawing submissions from the drawing game frontend.
 * This service is designed to scale independently for high write throughput.
 *
 * Features:
 * - Structured JSON logging with pino
 * - Prometheus metrics endpoint
 * - Health check endpoints for container orchestration
 * - Scheduled cleanup job for data lifecycle management
 *
 * @module collection
 */

import { app } from './app.js'
import { ensureBuckets } from '../shared/storage.js'
import { logger } from '../shared/logger.js'
import { startCleanupScheduler } from '../shared/cleanup.js'

/** Port for the collection service (default: 3001) */
const PORT = parseInt(process.env.PORT || '3001')

/** Cleanup scheduler interval ID for graceful shutdown */
let cleanupInterval: NodeJS.Timeout | undefined

/**
 * Starts the collection service.
 * Ensures MinIO buckets exist before accepting requests.
 * Starts the data lifecycle cleanup scheduler.
 */
async function start() {
  try {
    // Set service name for logging
    process.env.SERVICE_NAME = 'collection'

    // Ensure MinIO buckets exist
    await ensureBuckets()
    logger.info({ msg: 'MinIO buckets verified' })

    // Start cleanup scheduler (runs every 24 hours)
    // In production, you might run this as a separate worker or cron job
    const cleanupIntervalHours = parseInt(process.env.CLEANUP_INTERVAL_HOURS || '24')
    cleanupInterval = startCleanupScheduler(cleanupIntervalHours, {
      dryRun: process.env.CLEANUP_DRY_RUN === 'true',
      softDeleteRetentionDays: parseInt(process.env.SOFT_DELETE_RETENTION_DAYS || '30'),
      flaggedRetentionDays: parseInt(process.env.FLAGGED_RETENTION_DAYS || '90'),
    })
    logger.info({ msg: 'Cleanup scheduler started', intervalHours: cleanupIntervalHours })

    app.listen(PORT, () => {
      logger.info({
        msg: 'Collection service started',
        port: PORT,
        env: process.env.NODE_ENV || 'development',
      })
    })
  } catch (error) {
    logger.error({
      msg: 'Failed to start collection service',
      error: error instanceof Error ? error.message : String(error),
    })
    process.exit(1)
  }
}

/**
 * Graceful shutdown handler.
 * Cleans up resources before exiting.
 */
function shutdown(signal: string) {
  logger.info({ msg: 'Shutdown signal received', signal })

  if (cleanupInterval) {
    clearInterval(cleanupInterval)
    logger.info({ msg: 'Cleanup scheduler stopped' })
  }

  process.exit(0)
}

// Register shutdown handlers
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

start()
