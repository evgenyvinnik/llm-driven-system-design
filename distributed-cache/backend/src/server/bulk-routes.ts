/**
 * Bulk Operation Routes for Cache Server
 *
 * This module provides Express routes for bulk cache operations:
 * - GET /keys - List all keys (with optional pattern matching)
 * - POST /mget - Get multiple keys in a single request
 * - POST /mset - Set multiple keys in a single request
 * - POST /flush - Clear all keys from the cache
 *
 * @module server/bulk-routes
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { cacheHits, cacheMisses, cacheSets } from '../shared/metrics.js';
import type { ServerContext, MGetRequestBody, MSetRequestBody } from './types.js';

/**
 * Creates bulk operation routes.
 *
 * @description Factory function that creates an Express router with endpoints
 * for bulk cache operations. These operations allow efficient handling of
 * multiple keys in a single request, reducing network round trips.
 *
 * Supported routes:
 * - GET /keys - List cache keys matching an optional pattern
 * - POST /mget - Get values for multiple keys at once
 * - POST /mset - Set multiple key-value pairs at once
 * - POST /flush - Clear all entries from the cache
 *
 * @param {ServerContext} context - Server context with cache, hot key detector, config, and logger
 * @returns {Router} Express Router with bulk operation routes
 *
 * @example
 * ```typescript
 * const bulkRouter = createBulkRoutes(context);
 * app.use(bulkRouter);
 * ```
 */
export function createBulkRoutes(context: ServerContext): Router {
  const router = Router();
  const { cache, hotKeyDetector, config, logger } = context;
  const { nodeId } = config;

  /**
   * GET /keys - List all keys (with optional pattern)
   *
   * @description Returns a list of cache keys matching the specified pattern.
   * The pattern uses glob-style matching (e.g., 'user:*' matches all keys
   * starting with 'user:'). Results are limited to 1000 keys.
   *
   * @query {string} pattern - Glob pattern to match keys (default: '*' for all keys)
   * @returns 200 with pattern, count, and keys array (max 1000 keys)
   */
  router.get('/keys', (req: Request, res: Response) => {
    const pattern = (req.query.pattern as string) || '*';
    const keys = cache.keys(pattern);

    res.json({
      pattern,
      count: keys.length,
      keys: keys.slice(0, 1000), // Limit to first 1000 keys
    });
  });

  /**
   * POST /mget - Get multiple keys
   *
   * @description Retrieves values for multiple keys in a single request.
   * More efficient than individual GET requests when fetching many values.
   * Records access for hot key detection and updates hit/miss metrics.
   *
   * @body {string[]} keys - Array of cache keys to retrieve
   * @returns 200 with results object (key-value pairs), found count, and requested count
   * @returns 400 if keys is not an array
   */
  router.post('/mget', (req: Request, res: Response) => {
    const { keys } = req.body as MGetRequestBody;

    if (!Array.isArray(keys)) {
      res.status(400).json({
        error: 'Keys must be an array',
      });
      return;
    }

    const results: Record<string, unknown> = {};
    for (const key of keys) {
      hotKeyDetector.recordAccess(key);
      const value = cache.get(key);
      if (value !== undefined) {
        results[key] = value;
        cacheHits.labels(nodeId).inc();
      } else {
        cacheMisses.labels(nodeId).inc();
      }
    }

    res.json({
      results,
      found: Object.keys(results).length,
      requested: keys.length,
    });
  });

  /**
   * POST /mset - Set multiple keys
   *
   * @description Stores multiple key-value pairs in a single request.
   * More efficient than individual POST requests when storing many values.
   * Entries without a key or with undefined value are skipped.
   *
   * @body {CacheEntry[]} entries - Array of {key, value, ttl?} objects to store
   * @returns 200 with set count, requested count, and success message
   * @returns 400 if entries is not an array
   */
  router.post('/mset', (req: Request, res: Response) => {
    const { entries } = req.body as MSetRequestBody;

    if (!Array.isArray(entries)) {
      res.status(400).json({
        error: 'Entries must be an array',
      });
      return;
    }

    let set = 0;
    for (const entry of entries) {
      if (entry.key && entry.value !== undefined) {
        cache.set(entry.key, entry.value, entry.ttl || 0);
        cacheSets.labels(nodeId).inc();
        set++;
      }
    }

    res.json({
      set,
      requested: entries.length,
      message: 'Bulk set completed',
    });
  });

  /**
   * POST /flush - Clear all keys
   *
   * @description Removes all entries from the cache. This is a destructive
   * operation that cannot be undone. Logs the number of keys cleared for
   * auditing purposes.
   *
   * @returns 200 with success message and count of keys cleared
   */
  router.post('/flush', (_req: Request, res: Response) => {
    const statsBefore = cache.getStats();
    cache.clear();

    logger.info({ keysCleared: statsBefore.size }, 'cache_flushed');

    res.json({
      message: 'Cache flushed',
      keysCleared: statsBefore.size,
    });
  });

  return router;
}
