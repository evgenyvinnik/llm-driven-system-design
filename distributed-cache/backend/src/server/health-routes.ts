/**
 * Health and Metrics Routes for Cache Server
 *
 * This module provides Express routes for monitoring and observability:
 * - /health - Health check with cache and process stats
 * - /metrics - Prometheus metrics endpoint
 * - /info - Detailed node information
 * - /stats - Cache statistics
 * - /hot-keys - Hot key detection data
 *
 * @module server/health-routes
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { getMetrics, getContentType, updateCacheStats } from '../shared/metrics.js';
import { logHotKeysDetected } from '../shared/logger.js';
import type { ServerContext, HealthResponse } from './types.js';

/**
 * Creates health and metrics routes.
 *
 * @description Factory function that creates an Express router with endpoints
 * for health checks, Prometheus metrics, and cache statistics. These routes
 * are used for monitoring, debugging, and integration with orchestration systems.
 *
 * Supported routes:
 * - GET /health - Health check with basic cache and process stats
 * - GET /metrics - Prometheus-format metrics for scraping
 * - GET /info - Detailed node configuration and runtime info
 * - GET /stats - Current cache statistics
 * - GET /hot-keys - Detected hot keys within the monitoring window
 *
 * @param {ServerContext} context - Server context with cache, hot key detector, config, and logger
 * @returns {Router} Express Router with health and metrics routes
 *
 * @example
 * ```typescript
 * const healthRouter = createHealthRoutes(context);
 * app.use(healthRouter);
 * ```
 */
export function createHealthRoutes(context: ServerContext): Router {
  const router = Router();
  const { cache, hotKeyDetector, config, logger } = context;

  /**
   * Updates cache statistics metrics and logs hot keys.
   *
   * @description Helper function that collects current cache stats,
   * updates Prometheus metrics, and logs any detected hot keys.
   */
  function updateMetrics(): void {
    const stats = cache.getStats();
    updateCacheStats(config.nodeId, stats);

    const hotKeys = hotKeyDetector.getHotKeys();
    if (hotKeys.length > 0) {
      logHotKeysDetected(hotKeys);
    }
  }

  /**
   * GET /health - Health check endpoint
   *
   * @description Returns the health status of this cache node including
   * cache statistics and process memory usage. Used by the coordinator
   * for health monitoring and by load balancers for availability checks.
   *
   * @returns 200 with HealthResponse containing node status, cache stats, and process info
   */
  router.get('/health', (_req: Request, res: Response) => {
    const stats = cache.getStats();
    const memoryUsage = process.memoryUsage();

    const response: HealthResponse = {
      status: 'healthy',
      nodeId: config.nodeId,
      port: config.port,
      uptime: process.uptime(),
      cache: {
        entries: stats.size,
        memoryMB: stats.memoryMB,
        hitRate: stats.hitRate,
      },
      process: {
        heapUsedMB: (memoryUsage.heapUsed / 1024 / 1024).toFixed(2),
        heapTotalMB: (memoryUsage.heapTotal / 1024 / 1024).toFixed(2),
        rssMB: (memoryUsage.rss / 1024 / 1024).toFixed(2),
      },
      timestamp: new Date().toISOString(),
    };

    res.json(response);
  });

  /**
   * GET /metrics - Prometheus metrics endpoint
   *
   * @description Exposes cache and node metrics in Prometheus text format.
   * Updates metrics before returning to ensure fresh data. Used by
   * Prometheus scrapers for monitoring.
   *
   * @returns 200 with Prometheus text format metrics
   * @throws 500 if metrics collection fails
   */
  router.get('/metrics', async (_req: Request, res: Response) => {
    try {
      updateMetrics();
      res.set('Content-Type', getContentType());
      res.end(await getMetrics());
    } catch (error) {
      const err = error as Error;
      logger.error({ error: err.message }, 'metrics_error');
      res.status(500).end(err.message);
    }
  });

  /**
   * GET /info - Node info endpoint
   *
   * @description Returns comprehensive information about this cache node
   * including configuration, current statistics, hot keys, and memory usage.
   * Useful for debugging and capacity planning.
   *
   * @returns 200 with detailed node information
   */
  router.get('/info', (_req: Request, res: Response) => {
    res.json({
      nodeId: config.nodeId,
      port: config.port,
      config: {
        maxSize: config.maxSize,
        maxMemoryMB: config.maxMemoryMB,
        defaultTTL: config.defaultTTL,
      },
      stats: cache.getStats(),
      hotKeys: hotKeyDetector.getHotKeys(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * GET /stats - Cache statistics endpoint
   *
   * @description Returns current cache statistics including hits, misses,
   * evictions, and memory usage. Also includes detected hot keys.
   *
   * @returns 200 with cache statistics and hot keys
   */
  router.get('/stats', (_req: Request, res: Response) => {
    res.json({
      nodeId: config.nodeId,
      ...cache.getStats(),
      hotKeys: hotKeyDetector.getHotKeys(),
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * GET /hot-keys - Hot keys endpoint
   *
   * @description Returns the list of currently detected hot keys. Hot keys
   * are cache keys that receive a disproportionate amount of traffic and
   * may require special handling to prevent bottlenecks.
   *
   * @returns 200 with hot key list and detection parameters
   */
  router.get('/hot-keys', (_req: Request, res: Response) => {
    res.json({
      nodeId: config.nodeId,
      hotKeys: hotKeyDetector.getHotKeys(),
      windowMs: 60000,
      threshold: '1%',
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
