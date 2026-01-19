/**
 * Express Middleware for Cache Server
 *
 * This module provides common middleware functions for the cache server:
 * - Operation timing and metrics recording
 * - Error handling
 * - Metrics updates
 *
 * @module server/middleware
 */

import type { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import { recordOperation } from '../shared/metrics.js';
import type { ServerContext, AsyncRequestHandler, CacheOperation } from './types.js';

/**
 * Creates a middleware that measures operation duration and records metrics.
 *
 * @description Wraps an async request handler to measure its execution time
 * and record it to Prometheus metrics. The timing is recorded even if the
 * handler throws an error.
 *
 * @param {string} nodeId - The node identifier for metrics labels
 * @param {CacheOperation} operation - The operation type ('get', 'set', or 'delete')
 * @param {AsyncRequestHandler} handler - The async request handler to wrap
 * @returns {Function} Express middleware function that measures timing
 *
 * @example
 * ```typescript
 * router.get('/cache/:key', measureOperation(nodeId, 'get', async (req, res) => {
 *   const value = cache.get(req.params.key);
 *   res.json({ value });
 * }));
 * ```
 */
export function measureOperation(
  nodeId: string,
  operation: CacheOperation,
  handler: AsyncRequestHandler
) {
  /**
   * Wrapped middleware that times the handler and records metrics.
   *
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   * @param {NextFunction} next - Express next function
   * @returns {Promise<void>} Promise that resolves when timing is recorded
   */
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const start = performance.now();
    try {
      await handler(req, res, next);
    } finally {
      const duration = performance.now() - start;
      recordOperation(nodeId, operation, duration);
    }
  };
}

/**
 * Creates the global error handling middleware.
 *
 * @description Factory function that creates an Express error handler middleware.
 * This middleware catches any unhandled errors from route handlers, logs them
 * with the server's logger, and returns a consistent error response format.
 *
 * @param {ServerContext} context - Server context containing the logger
 * @returns {ErrorRequestHandler} Express error handler middleware
 *
 * @example
 * ```typescript
 * const errorHandler = createErrorHandler(context);
 * app.use(errorHandler);
 * ```
 */
export function createErrorHandler(context: ServerContext): ErrorRequestHandler {
  /**
   * Error handling middleware.
   *
   * @param {Error} err - The error that was thrown
   * @param {Request} _req - Express request object (unused)
   * @param {Response} res - Express response object
   * @param {NextFunction} _next - Express next function (unused)
   */
  return (
    err: Error,
    _req: Request,
    res: Response,
    _next: NextFunction
  ): void => {
    context.logger.error({ error: err.message, stack: err.stack }, 'unhandled_error');
    res.status(500).json({
      error: 'Internal server error',
      message: err.message,
    });
  };
}

/**
 * Creates a function to update cache statistics metrics.
 *
 * @description Factory function that creates a metrics update function.
 * The returned function updates Prometheus cache statistics and logs
 * any detected hot keys. Call this periodically to keep metrics current.
 *
 * @param {ServerContext} context - Server context with cache and hot key detector
 * @returns {Function} Function that updates metrics when called
 *
 * @example
 * ```typescript
 * const updateMetrics = createMetricsUpdater(context);
 * setInterval(updateMetrics, 5000); // Update every 5 seconds
 * ```
 */
export function createMetricsUpdater(context: ServerContext) {
  const { cache, hotKeyDetector, config } = context;

  /**
   * Updates cache statistics metrics and logs hot keys.
   *
   * @description Collects current cache statistics and updates Prometheus
   * metrics. Also checks for hot keys and logs them if detected.
   */
  return function updateMetrics(): void {
    const { updateCacheStats } = require('../shared/metrics.js');
    const { logHotKeysDetected } = require('../shared/logger.js');

    const stats = cache.getStats();
    updateCacheStats(config.nodeId, stats);

    // Check for hot keys
    const hotKeys = hotKeyDetector.getHotKeys();
    if (hotKeys.length > 0) {
      logHotKeysDetected(hotKeys);
    }
  };
}
