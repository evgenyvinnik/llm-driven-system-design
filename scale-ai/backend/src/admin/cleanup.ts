/**
 * Cleanup routes for the admin service.
 * Handles manual triggering of data lifecycle cleanup jobs.
 * @module admin/cleanup
 */

import { Router, Request, Response } from 'express'
import { createChildLogger, logError } from '../shared/logger.js'
import { runAllCleanupJobs, LifecycleConfig } from '../shared/cleanup.js'
import { requireAdmin } from './auth.js'

const router = Router()

/**
 * POST /api/admin/cleanup/run - Manually triggers cleanup jobs.
 *
 * @description Executes data lifecycle cleanup operations including:
 *   - Hard deletion of soft-deleted records past retention period
 *   - Archival of flagged drawings
 *   - Detection and cleanup of orphaned storage objects
 *
 *   Supports dry run mode to preview changes without applying them.
 *
 * @route POST /api/admin/cleanup/run
 *
 * @param {Request} req - Express request with optional body:
 *   - dryRun {boolean} [default=false] - Preview changes without applying
 *   - batchSize {number} [default=100] - Number of records to process per batch
 * @param {Response} res - Express response object
 *
 * @returns {object} 200 - Cleanup results summary
 * @returns {object} 500 - If cleanup fails
 *
 * @example
 * // Request body (dry run)
 * { "dryRun": true, "batchSize": 50 }
 *
 * // Success response
 * {
 *   "success": true,
 *   "totalDeleted": 25,
 *   "totalErrors": 0,
 *   "results": [
 *     { "job": "soft-delete-cleanup", "deletedCount": 15, "errorCount": 0 },
 *     { "job": "orphan-detection", "deletedCount": 10, "errorCount": 0 }
 *   ]
 * }
 */
router.post('/run', requireAdmin, async (req: Request, res: Response) => {
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

export { router as cleanupRouter }
