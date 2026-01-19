/**
 * Admin Routes for Cache Server
 *
 * This module provides administrative endpoints for cache persistence:
 * - POST /snapshot - Force an immediate cache snapshot
 * - GET /snapshots - List available snapshots
 *
 * @module server/admin-routes
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { ServerContext } from './types.js';

/**
 * Creates admin routes for persistence and management.
 *
 * @description Factory function that creates an Express router with endpoints
 * for administrative operations on the cache node. These routes allow operators
 * to manage cache persistence and view snapshot history.
 *
 * Supported routes:
 * - POST /snapshot - Force an immediate snapshot to disk
 * - GET /snapshots - List all available snapshots
 *
 * @param {ServerContext} context - Server context with persistence manager, config, and logger
 * @returns {Router} Express Router with admin routes
 *
 * @example
 * ```typescript
 * const adminRouter = createAdminRoutes(context);
 * app.use(adminRouter);
 * ```
 */
export function createAdminRoutes(context: ServerContext): Router {
  const router = Router();
  const { persistence, config, logger } = context;

  /**
   * POST /snapshot - Force a snapshot
   *
   * @description Triggers an immediate snapshot of the cache to disk.
   * The snapshot includes all current cache entries and their TTLs.
   * Useful before maintenance or to ensure data durability.
   *
   * @returns 200 with snapshot result (file path, entry count, duration)
   * @throws 500 if snapshot fails (disk error, permission issue, etc.)
   */
  router.post('/snapshot', async (_req: Request, res: Response) => {
    try {
      const result = await persistence.forceSnapshot();
      res.json({
        message: 'Snapshot created',
        ...result,
      });
    } catch (error) {
      const err = error as Error;
      logger.error({ error: err.message }, 'snapshot_failed');
      res.status(500).json({
        error: 'Snapshot failed',
        message: err.message,
      });
    }
  });

  /**
   * GET /snapshots - List available snapshots
   *
   * @description Returns a list of all available snapshot files for this node.
   * Each snapshot entry includes the filename, size, and creation timestamp.
   * Useful for monitoring backup status and recovery planning.
   *
   * @returns 200 with nodeId and array of snapshot metadata
   * @throws 500 if listing fails (directory access error, etc.)
   */
  router.get('/snapshots', async (_req: Request, res: Response) => {
    try {
      const snapshots = await persistence.listSnapshots();
      res.json({
        nodeId: config.nodeId,
        snapshots,
      });
    } catch (error) {
      const err = error as Error;
      logger.error({ error: err.message }, 'list_snapshots_failed');
      res.status(500).json({
        error: 'Failed to list snapshots',
        message: err.message,
      });
    }
  });

  return router;
}
