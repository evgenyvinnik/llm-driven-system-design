/**
 * Cache Operation Routes for Cache Server
 *
 * This module provides Express routes for single-key cache operations:
 * - GET /cache/:key - Get a cached value
 * - POST /cache/:key - Set a cached value
 * - PUT /cache/:key - Update a cached value
 * - DELETE /cache/:key - Delete a cached key
 * - GET /cache/:key/exists - Check if a key exists
 * - GET /cache/:key/ttl - Get the TTL for a key
 * - POST /cache/:key/expire - Set TTL on an existing key
 * - POST /cache/:key/incr - Increment a numeric value
 * - GET /cache/:key/info - Get detailed key information
 *
 * @module server/cache-routes
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  cacheHits,
  cacheMisses,
  cacheSets,
  cacheDeletes,
} from '../shared/metrics.js';
import {
  logCacheHit,
  logCacheMiss,
  logCacheSet,
  logCacheDelete,
} from '../shared/logger.js';
import { measureOperation } from './middleware.js';
import type {
  ServerContext,
  SetRequestBody,
  ExpireRequestBody,
  IncrRequestBody,
} from './types.js';

/**
 * Creates cache operation routes for single-key operations.
 *
 * @description Factory function that creates an Express router handling all
 * single-key cache operations. These are the core CRUD operations for the cache
 * plus additional operations like TTL management and atomic increments.
 *
 * All routes use the :key URL parameter to identify the cache key.
 * GET, POST, PUT, and DELETE operations are instrumented with timing metrics.
 *
 * Supported routes:
 * - GET /cache/:key - Retrieve a cached value
 * - POST /cache/:key - Store a new value
 * - PUT /cache/:key - Update an existing value (same behavior as POST)
 * - DELETE /cache/:key - Remove a key from the cache
 * - GET /cache/:key/exists - Check if a key exists without retrieving its value
 * - GET /cache/:key/ttl - Get the remaining TTL for a key
 * - POST /cache/:key/expire - Set a new TTL on an existing key
 * - POST /cache/:key/incr - Atomically increment a numeric value
 * - GET /cache/:key/info - Get detailed metadata about a key
 *
 * @param {ServerContext} context - Server context with cache, hot key detector, and config
 * @returns {Router} Express Router with cache operation routes
 *
 * @example
 * ```typescript
 * const cacheRouter = createCacheRoutes(context);
 * app.use(cacheRouter);
 * ```
 */
export function createCacheRoutes(context: ServerContext): Router {
  const router = Router();
  const { cache, hotKeyDetector, config } = context;
  const { nodeId } = config;

  /**
   * GET /cache/:key - Get a value from cache
   *
   * @description Retrieves a cached value by key. Records the access for
   * hot key detection and updates hit/miss metrics. Returns the value
   * along with its remaining TTL.
   *
   * @param {string} key - The cache key (URL parameter)
   * @returns 200 with {key, value, ttl} if found
   * @returns 404 if the key does not exist
   */
  router.get(
    '/cache/:key',
    measureOperation(nodeId, 'get', async (req: Request, res: Response) => {
      const { key } = req.params;

      hotKeyDetector.recordAccess(key);
      const value = cache.get(key);

      if (value === undefined) {
        cacheMisses.labels(nodeId).inc();
        logCacheMiss(key, 0);
        res.status(404).json({ error: 'Key not found', key });
        return;
      }

      cacheHits.labels(nodeId).inc();
      logCacheHit(key, 0);
      res.json({ key, value, ttl: cache.ttl(key) });
    })
  );

  /**
   * POST /cache/:key - Set a value in cache
   *
   * @description Stores a value in the cache with an optional TTL.
   * If the key already exists, it is overwritten. Updates set metrics
   * and logs the operation.
   *
   * @param {string} key - The cache key (URL parameter)
   * @body {unknown} value - The value to store (required)
   * @body {number} [ttl=0] - TTL in seconds (0 = no expiration)
   * @returns 201 with {key, ttl, message} on success
   * @returns 400 if value is not provided
   */
  router.post(
    '/cache/:key',
    measureOperation(nodeId, 'set', async (req: Request, res: Response) => {
      const { key } = req.params;
      const { value, ttl = 0 } = req.body as SetRequestBody;

      if (value === undefined) {
        res.status(400).json({ error: 'Value is required' });
        return;
      }

      cache.set(key, value, ttl);
      cacheSets.labels(nodeId).inc();
      logCacheSet(key, ttl, 0);
      res.status(201).json({ key, ttl: cache.ttl(key), message: 'Value set successfully' });
    })
  );

  /**
   * PUT /cache/:key - Update a value in cache (same as POST)
   *
   * @description Updates a value in the cache. Functionally identical to POST
   * but returns 200 instead of 201 to indicate an update rather than creation.
   *
   * @param {string} key - The cache key (URL parameter)
   * @body {unknown} value - The value to store (required)
   * @body {number} [ttl=0] - TTL in seconds (0 = no expiration)
   * @returns 200 with {key, ttl, message} on success
   * @returns 400 if value is not provided
   */
  router.put(
    '/cache/:key',
    measureOperation(nodeId, 'set', async (req: Request, res: Response) => {
      const { key } = req.params;
      const { value, ttl = 0 } = req.body as SetRequestBody;

      if (value === undefined) {
        res.status(400).json({ error: 'Value is required' });
        return;
      }

      cache.set(key, value, ttl);
      cacheSets.labels(nodeId).inc();
      logCacheSet(key, ttl, 0);
      res.json({ key, ttl: cache.ttl(key), message: 'Value updated successfully' });
    })
  );

  /**
   * DELETE /cache/:key - Delete a key from cache
   *
   * @description Removes a key and its value from the cache. Updates delete
   * metrics and logs the operation if the key existed.
   *
   * @param {string} key - The cache key (URL parameter)
   * @returns 200 with {key, message} if deleted
   * @returns 404 if the key did not exist
   */
  router.delete(
    '/cache/:key',
    measureOperation(nodeId, 'delete', async (req: Request, res: Response) => {
      const { key } = req.params;
      const deleted = cache.delete(key);

      if (!deleted) {
        res.status(404).json({ error: 'Key not found', key });
        return;
      }

      cacheDeletes.labels(nodeId).inc();
      logCacheDelete(key);
      res.json({ key, message: 'Key deleted successfully' });
    })
  );

  /**
   * GET /cache/:key/exists - Check if a key exists
   *
   * @description Checks whether a key exists in the cache without retrieving
   * its value. More efficient than GET when you only need to check existence.
   * Does not affect TTL or access tracking.
   *
   * @param {string} key - The cache key (URL parameter)
   * @returns 200 with {key, exists: boolean}
   */
  router.get('/cache/:key/exists', (req: Request, res: Response) => {
    const { key } = req.params;
    res.json({ key, exists: cache.has(key) });
  });

  /**
   * GET /cache/:key/ttl - Get TTL for a key
   *
   * @description Returns the remaining TTL (time to live) for a key in seconds.
   * Returns -1 if the key exists but has no expiration. Returns -2 (via 404)
   * if the key does not exist.
   *
   * @param {string} key - The cache key (URL parameter)
   * @returns 200 with {key, ttl, hasExpiration} if key exists
   * @returns 404 if the key does not exist
   */
  router.get('/cache/:key/ttl', (req: Request, res: Response) => {
    const { key } = req.params;
    const ttl = cache.ttl(key);

    if (ttl === -2) {
      res.status(404).json({ error: 'Key not found', key });
      return;
    }

    res.json({ key, ttl, hasExpiration: ttl !== -1 });
  });

  /**
   * POST /cache/:key/expire - Set TTL on an existing key
   *
   * @description Sets a new TTL on an existing key without modifying its value.
   * The key must already exist. Use TTL of 0 to remove expiration.
   *
   * @param {string} key - The cache key (URL parameter)
   * @body {number} ttl - The new TTL in seconds (required)
   * @returns 200 with {key, ttl, message} on success
   * @returns 400 if ttl is not provided or not a number
   * @returns 404 if the key does not exist
   */
  router.post('/cache/:key/expire', (req: Request, res: Response) => {
    const { key } = req.params;
    const { ttl } = req.body as ExpireRequestBody;

    if (ttl === undefined || typeof ttl !== 'number') {
      res.status(400).json({ error: 'TTL is required and must be a number' });
      return;
    }

    const success = cache.expire(key, ttl);
    if (!success) {
      res.status(404).json({ error: 'Key not found', key });
      return;
    }

    res.json({ key, ttl: cache.ttl(key), message: 'TTL set successfully' });
  });

  /**
   * POST /cache/:key/incr - Increment a numeric value
   *
   * @description Atomically increments a numeric value stored at the key.
   * If the key does not exist, it is set to 0 before incrementing.
   * Supports negative delta for decrement operations.
   *
   * @param {string} key - The cache key (URL parameter)
   * @body {number} [delta=1] - Amount to increment by (negative to decrement)
   * @returns 200 with {key, value} containing the new value
   * @returns 400 if the stored value is not a number
   */
  router.post('/cache/:key/incr', (req: Request, res: Response) => {
    const { key } = req.params;
    const { delta = 1 } = req.body as IncrRequestBody;

    const result = cache.incr(key, delta);
    if (result === null) {
      res.status(400).json({ error: 'Value is not a number', key });
      return;
    }

    res.json({ key, value: result });
  });

  /**
   * GET /cache/:key/info - Get detailed info about a key
   *
   * @description Returns detailed metadata about a cached key including
   * its value, TTL, creation time, last access time, and access count.
   * Useful for debugging and understanding cache behavior.
   *
   * @param {string} key - The cache key (URL parameter)
   * @returns 200 with detailed key information
   * @returns 404 if the key does not exist
   */
  router.get('/cache/:key/info', (req: Request, res: Response) => {
    const { key } = req.params;
    const info = cache.getKeyInfo(key);

    if (!info) {
      res.status(404).json({ error: 'Key not found', key });
      return;
    }

    res.json(info);
  });

  return router;
}
