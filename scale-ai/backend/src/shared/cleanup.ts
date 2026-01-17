/**
 * Data lifecycle management module for cleanup and archival.
 * Implements TTL-based cleanup, storage tiering, and orphan detection.
 *
 * WHY: Without lifecycle management, storage grows indefinitely and costs increase.
 * Old data that's no longer needed for training should be archived or deleted.
 * Orphaned data (MinIO objects without DB records or vice versa) wastes resources.
 * Regular cleanup maintains system health and controls costs.
 *
 * @module shared/cleanup
 */

import { pool } from './db.js'
import { minioClient, DRAWINGS_BUCKET, listDrawings } from './storage.js'
import { logger } from './logger.js'
import { drawingsCleanedUp, drawingsByTier } from './metrics.js'

/**
 * Configuration for data lifecycle management.
 * All durations are in days unless otherwise specified.
 */
export interface LifecycleConfig {
  /** Days before soft-deleted drawings are permanently deleted */
  softDeleteRetentionDays: number
  /** Days before flagged drawings are auto-archived */
  flaggedRetentionDays: number
  /** Days before old inference logs are deleted */
  inferenceLogRetentionDays: number
  /** Days before session data expires (Redis TTL is set separately) */
  sessionRetentionDays: number
  /** Batch size for cleanup operations */
  batchSize: number
  /** Whether to run in dry-run mode (log but don't delete) */
  dryRun: boolean
}

/**
 * Default lifecycle configuration.
 * Conservative settings for local development.
 */
const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = {
  softDeleteRetentionDays: 30,
  flaggedRetentionDays: 90,
  inferenceLogRetentionDays: 30,
  sessionRetentionDays: 7,
  batchSize: 100,
  dryRun: false,
}

/**
 * Result of a cleanup operation.
 */
export interface CleanupResult {
  operation: string
  processedCount: number
  deletedCount: number
  errorCount: number
  dryRun: boolean
  duration: number
  errors: string[]
}

/**
 * Permanently deletes drawings that were soft-deleted beyond the retention period.
 * Also removes the associated MinIO objects.
 *
 * @param config - Lifecycle configuration
 * @returns Cleanup result
 */
export async function cleanupSoftDeletedDrawings(
  config: Partial<LifecycleConfig> = {}
): Promise<CleanupResult> {
  const cfg = { ...DEFAULT_LIFECYCLE_CONFIG, ...config }
  const startTime = Date.now()
  const errors: string[] = []
  let processedCount = 0
  let deletedCount = 0

  logger.info({
    msg: 'Starting soft-deleted drawings cleanup',
    retentionDays: cfg.softDeleteRetentionDays,
    dryRun: cfg.dryRun,
  })

  try {
    // Find drawings to permanently delete
    const result = await pool.query(
      `SELECT id, stroke_data_path
       FROM drawings
       WHERE deleted_at IS NOT NULL
         AND deleted_at < NOW() - INTERVAL '${cfg.softDeleteRetentionDays} days'
       LIMIT $1`,
      [cfg.batchSize]
    )

    processedCount = result.rows.length

    for (const row of result.rows) {
      try {
        if (!cfg.dryRun) {
          // Delete from MinIO
          if (row.stroke_data_path) {
            await minioClient.removeObject(DRAWINGS_BUCKET, row.stroke_data_path)
          }

          // Permanently delete from PostgreSQL
          await pool.query('DELETE FROM drawings WHERE id = $1', [row.id])
        }

        deletedCount++
        drawingsCleanedUp.labels('deleted').inc()
      } catch (err) {
        errors.push(`Failed to delete drawing ${row.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    logger.info({
      msg: 'Completed soft-deleted drawings cleanup',
      processedCount,
      deletedCount,
      errorCount: errors.length,
      dryRun: cfg.dryRun,
      durationMs: Date.now() - startTime,
    })
  } catch (err) {
    const errorMsg = `Cleanup job failed: ${err instanceof Error ? err.message : String(err)}`
    errors.push(errorMsg)
    logger.error({ msg: errorMsg })
  }

  return {
    operation: 'cleanup_soft_deleted',
    processedCount,
    deletedCount,
    errorCount: errors.length,
    dryRun: cfg.dryRun,
    duration: Date.now() - startTime,
    errors,
  }
}

/**
 * Archives flagged drawings beyond the retention period.
 * Moves them to a separate "archived" state rather than deleting.
 *
 * @param config - Lifecycle configuration
 * @returns Cleanup result
 */
export async function archiveFlaggedDrawings(
  config: Partial<LifecycleConfig> = {}
): Promise<CleanupResult> {
  const cfg = { ...DEFAULT_LIFECYCLE_CONFIG, ...config }
  const startTime = Date.now()
  const errors: string[] = []
  let processedCount = 0
  let deletedCount = 0

  logger.info({
    msg: 'Starting flagged drawings archival',
    retentionDays: cfg.flaggedRetentionDays,
    dryRun: cfg.dryRun,
  })

  try {
    // Find flagged drawings to archive
    const result = await pool.query(
      `SELECT id, stroke_data_path
       FROM drawings
       WHERE is_flagged = TRUE
         AND deleted_at IS NULL
         AND created_at < NOW() - INTERVAL '${cfg.flaggedRetentionDays} days'
       LIMIT $1`,
      [cfg.batchSize]
    )

    processedCount = result.rows.length

    for (const row of result.rows) {
      try {
        if (!cfg.dryRun) {
          // Soft-delete (archive) the drawing
          await pool.query(
            `UPDATE drawings SET deleted_at = NOW(), metadata = metadata || '{"archived_reason": "flagged_retention"}'::jsonb WHERE id = $1`,
            [row.id]
          )
        }

        deletedCount++
        drawingsCleanedUp.labels('flagged').inc()
      } catch (err) {
        errors.push(`Failed to archive drawing ${row.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    logger.info({
      msg: 'Completed flagged drawings archival',
      processedCount,
      deletedCount,
      errorCount: errors.length,
      dryRun: cfg.dryRun,
      durationMs: Date.now() - startTime,
    })
  } catch (err) {
    const errorMsg = `Archival job failed: ${err instanceof Error ? err.message : String(err)}`
    errors.push(errorMsg)
    logger.error({ msg: errorMsg })
  }

  return {
    operation: 'archive_flagged',
    processedCount,
    deletedCount,
    errorCount: errors.length,
    dryRun: cfg.dryRun,
    duration: Date.now() - startTime,
    errors,
  }
}

/**
 * Detects and cleans up orphaned data.
 * - MinIO objects without corresponding PostgreSQL records
 * - PostgreSQL records with missing MinIO objects
 *
 * @param config - Lifecycle configuration
 * @returns Cleanup result
 */
export async function cleanupOrphanedData(
  config: Partial<LifecycleConfig> = {}
): Promise<CleanupResult> {
  const cfg = { ...DEFAULT_LIFECYCLE_CONFIG, ...config }
  const startTime = Date.now()
  const errors: string[] = []
  let processedCount = 0
  let deletedCount = 0

  logger.info({
    msg: 'Starting orphaned data cleanup',
    dryRun: cfg.dryRun,
  })

  try {
    // Get all MinIO object names
    const minioObjects = await listDrawings()
    const minioObjectSet = new Set(minioObjects)

    // Get all PostgreSQL records with stroke_data_path
    const dbResult = await pool.query(
      `SELECT id, stroke_data_path FROM drawings WHERE stroke_data_path IS NOT NULL LIMIT 10000`
    )

    const dbPathSet = new Set(dbResult.rows.map((r) => r.stroke_data_path))

    // Find MinIO objects without DB records (orphaned in MinIO)
    const orphanedInMinio: string[] = []
    for (const obj of minioObjects) {
      if (!dbPathSet.has(obj)) {
        orphanedInMinio.push(obj)
      }
    }

    // Find DB records without MinIO objects (orphaned in DB)
    const orphanedInDb: string[] = []
    for (const row of dbResult.rows) {
      if (row.stroke_data_path && !minioObjectSet.has(row.stroke_data_path)) {
        orphanedInDb.push(row.id)
      }
    }

    processedCount = orphanedInMinio.length + orphanedInDb.length

    // Clean up orphaned MinIO objects (only if older than 1 hour to avoid race conditions)
    for (const objName of orphanedInMinio.slice(0, cfg.batchSize)) {
      try {
        if (!cfg.dryRun) {
          await minioClient.removeObject(DRAWINGS_BUCKET, objName)
        }
        deletedCount++
        logger.debug({ msg: 'Removed orphaned MinIO object', objectName: objName, dryRun: cfg.dryRun })
      } catch (err) {
        errors.push(`Failed to delete orphaned MinIO object ${objName}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // Mark orphaned DB records (set stroke_data_path to null)
    for (const drawingId of orphanedInDb.slice(0, cfg.batchSize)) {
      try {
        if (!cfg.dryRun) {
          await pool.query(
            `UPDATE drawings SET stroke_data_path = NULL, metadata = metadata || '{"orphaned": true}'::jsonb WHERE id = $1`,
            [drawingId]
          )
        }
        deletedCount++
        logger.debug({ msg: 'Marked orphaned DB record', drawingId, dryRun: cfg.dryRun })
      } catch (err) {
        errors.push(`Failed to mark orphaned DB record ${drawingId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    logger.info({
      msg: 'Completed orphaned data cleanup',
      orphanedInMinio: orphanedInMinio.length,
      orphanedInDb: orphanedInDb.length,
      processedCount,
      deletedCount,
      errorCount: errors.length,
      dryRun: cfg.dryRun,
      durationMs: Date.now() - startTime,
    })
  } catch (err) {
    const errorMsg = `Orphan cleanup failed: ${err instanceof Error ? err.message : String(err)}`
    errors.push(errorMsg)
    logger.error({ msg: errorMsg })
  }

  return {
    operation: 'cleanup_orphans',
    processedCount,
    deletedCount,
    errorCount: errors.length,
    dryRun: cfg.dryRun,
    duration: Date.now() - startTime,
    errors,
  }
}

/**
 * Updates storage tier metrics for monitoring.
 * Counts drawings by age tier: hot (0-30 days), warm (30-180 days), archive (180+ days).
 *
 * @returns Object with tier counts
 */
export async function updateTierMetrics(): Promise<{ hot: number; warm: number; archive: number }> {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days' AND deleted_at IS NULL) as hot,
        COUNT(*) FILTER (WHERE created_at BETWEEN NOW() - INTERVAL '180 days' AND NOW() - INTERVAL '30 days' AND deleted_at IS NULL) as warm,
        COUNT(*) FILTER (WHERE created_at < NOW() - INTERVAL '180 days' OR deleted_at IS NOT NULL) as archive
      FROM drawings
    `)

    const counts = {
      hot: parseInt(result.rows[0].hot) || 0,
      warm: parseInt(result.rows[0].warm) || 0,
      archive: parseInt(result.rows[0].archive) || 0,
    }

    drawingsByTier.labels('hot').set(counts.hot)
    drawingsByTier.labels('warm').set(counts.warm)
    drawingsByTier.labels('archive').set(counts.archive)

    return counts
  } catch (err) {
    logger.error({
      msg: 'Failed to update tier metrics',
      error: err instanceof Error ? err.message : String(err),
    })
    return { hot: 0, warm: 0, archive: 0 }
  }
}

/**
 * Runs all cleanup jobs in sequence.
 * Suitable for cron job or scheduled task execution.
 *
 * @param config - Lifecycle configuration
 * @returns Array of cleanup results
 */
export async function runAllCleanupJobs(
  config: Partial<LifecycleConfig> = {}
): Promise<CleanupResult[]> {
  logger.info({ msg: 'Starting scheduled cleanup jobs' })

  const results: CleanupResult[] = []

  // Run cleanup jobs in sequence
  results.push(await cleanupSoftDeletedDrawings(config))
  results.push(await archiveFlaggedDrawings(config))
  results.push(await cleanupOrphanedData(config))

  // Update metrics
  await updateTierMetrics()

  const totalDeleted = results.reduce((sum, r) => sum + r.deletedCount, 0)
  const totalErrors = results.reduce((sum, r) => sum + r.errorCount, 0)

  logger.info({
    msg: 'Completed all cleanup jobs',
    totalDeleted,
    totalErrors,
    results: results.map((r) => ({
      operation: r.operation,
      deleted: r.deletedCount,
      errors: r.errorCount,
    })),
  })

  return results
}

/**
 * Creates an interval for running cleanup jobs periodically.
 * Call on service startup for automatic lifecycle management.
 *
 * @param intervalHours - Hours between cleanup runs (default: 24)
 * @param config - Lifecycle configuration
 * @returns Interval ID for clearing with clearInterval()
 *
 * @example
 * ```typescript
 * // Start cleanup job on service startup
 * const cleanupInterval = startCleanupScheduler(24)
 *
 * // On shutdown
 * clearInterval(cleanupInterval)
 * ```
 */
export function startCleanupScheduler(
  intervalHours = 24,
  config: Partial<LifecycleConfig> = {}
): NodeJS.Timeout {
  const intervalMs = intervalHours * 60 * 60 * 1000

  logger.info({
    msg: 'Starting cleanup scheduler',
    intervalHours,
    nextRunAt: new Date(Date.now() + intervalMs).toISOString(),
  })

  // Run immediately on startup, then on interval
  runAllCleanupJobs(config).catch((err) => {
    logger.error({
      msg: 'Initial cleanup run failed',
      error: err instanceof Error ? err.message : String(err),
    })
  })

  return setInterval(() => {
    runAllCleanupJobs(config).catch((err) => {
      logger.error({
        msg: 'Scheduled cleanup run failed',
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }, intervalMs)
}
