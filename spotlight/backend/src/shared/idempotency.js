import crypto from 'crypto';
import { redis, cacheGet, cacheSet, cacheDel } from './redis.js';
import { idempotencyCacheHitsTotal } from './metrics.js';
import { indexLogger } from './logger.js';

/**
 * Redis-backed idempotency store
 * Provides distributed idempotency checking across multiple server instances
 */
class IdempotencyStore {
  constructor() {
    // Default TTL: 24 hours (in seconds for Redis)
    this.ttlSeconds = 24 * 60 * 60;
    this.keyPrefix = 'idempotency:';
  }

  /**
   * Get a cached result for an idempotency key
   * @param {string} key - Idempotency key
   * @returns {Promise<Object|null>} - Cached result or null
   */
  async get(key) {
    const entry = await cacheGet(this.keyPrefix + key);
    return entry;
  }

  /**
   * Set a result for an idempotency key
   * @param {string} key - Idempotency key
   * @param {Object} result - Result to cache
   * @param {string} status - Status of the operation
   */
  async set(key, result, status = 'completed') {
    await cacheSet(
      this.keyPrefix + key,
      { result, status, timestamp: Date.now() },
      this.ttlSeconds
    );
  }

  /**
   * Mark an operation as in-progress
   * Uses Redis SETNX for atomic check-and-set
   * @param {string} key - Idempotency key
   * @returns {Promise<boolean>} - True if successfully marked, false if already in progress
   */
  async markInProgress(key) {
    const redisKey = this.keyPrefix + key;
    // Use SETNX (SET if Not eXists) for atomic operation
    const result = await redis.setnx(redisKey, JSON.stringify({
      result: null,
      status: 'in_progress',
      timestamp: Date.now()
    }));

    if (result === 1) {
      // Successfully set, add expiry
      await redis.expire(redisKey, this.ttlSeconds);
      return true;
    }
    return false;
  }

  /**
   * Remove an idempotency key (for failed operations that should be retried)
   * @param {string} key - Idempotency key
   */
  async remove(key) {
    await cacheDel(this.keyPrefix + key);
  }

  /**
   * Get the approximate number of cached entries (for monitoring)
   * @returns {Promise<number>} - Number of entries
   */
  async size() {
    const keys = await redis.keys(this.keyPrefix + '*');
    return keys.length;
  }

  /**
   * Stop the store (no-op for Redis, kept for API compatibility)
   */
  stop() {
    // Redis handles its own connection management
  }
}

// Singleton store instance
const store = new IdempotencyStore();

/**
 * Generate an idempotency key from request data
 * @param {string} operation - Operation type (e.g., 'index_file')
 * @param {Object} data - Request data to hash
 * @returns {string} - Generated idempotency key
 */
export function generateIdempotencyKey(operation, data) {
  const hash = crypto.createHash('sha256');
  hash.update(operation);
  hash.update(JSON.stringify(data));
  return `${operation}:${hash.digest('hex').substring(0, 32)}`;
}

/**
 * Express middleware for handling idempotency
 * Checks Idempotency-Key header and returns cached results if available
 * @param {string} operationType - Type of operation for logging/metrics
 */
export function idempotencyMiddleware(operationType = 'unknown') {
  return async (req, res, next) => {
    const idempotencyKey = req.headers['idempotency-key'];

    if (!idempotencyKey) {
      // No idempotency key provided, proceed normally
      return next();
    }

    // Check for cached result
    const cached = await store.get(idempotencyKey);

    if (cached) {
      if (cached.status === 'in_progress') {
        // Operation is still in progress
        return res.status(409).json({
          error: 'Request with this idempotency key is still in progress',
          code: 'OPERATION_IN_PROGRESS',
          idempotencyKey
        });
      }

      // Return cached result
      idempotencyCacheHitsTotal.labels(operationType).inc();
      indexLogger.info({
        idempotencyKey,
        operationType,
        cacheHit: true
      }, 'Idempotency cache hit');

      res.set('X-Idempotency-Key', idempotencyKey);
      res.set('X-Idempotency-Replayed', 'true');
      return res.status(cached.result.statusCode || 200).json(cached.result.body);
    }

    // Mark operation as in progress
    const marked = await store.markInProgress(idempotencyKey);
    if (!marked) {
      // Race condition: another request just started
      return res.status(409).json({
        error: 'Request with this idempotency key is being processed',
        code: 'OPERATION_IN_PROGRESS',
        idempotencyKey
      });
    }

    // Store original json method to capture response
    const originalJson = res.json.bind(res);
    let responseBody = null;
    let responseStatus = 200;

    res.json = (body) => {
      responseBody = body;
      responseStatus = res.statusCode;
      return originalJson(body);
    };

    // Handle response finish to cache result
    res.on('finish', async () => {
      if (responseBody !== null) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          // Only cache successful responses
          await store.set(idempotencyKey, {
            statusCode: responseStatus,
            body: responseBody
          });

          indexLogger.info({
            idempotencyKey,
            operationType,
            cached: true
          }, 'Idempotency result cached');
        } else {
          // Remove failed operations so they can be retried
          await store.remove(idempotencyKey);
        }
      } else {
        // No response body, remove from cache
        await store.remove(idempotencyKey);
      }
    });

    // Add idempotency key to response headers
    res.set('X-Idempotency-Key', idempotencyKey);

    next();
  };
}

/**
 * Wrapper function for idempotent operations
 * @param {string} idempotencyKey - The idempotency key
 * @param {Function} operation - Async function to execute
 * @param {string} operationType - Type of operation for logging
 * @returns {Promise<Object>} - Result of the operation
 */
export async function withIdempotency(idempotencyKey, operation, operationType = 'unknown') {
  if (!idempotencyKey) {
    // No key, just execute the operation
    return operation();
  }

  // Check for cached result
  const cached = await store.get(idempotencyKey);

  if (cached) {
    if (cached.status === 'in_progress') {
      throw new Error('Operation with this idempotency key is still in progress');
    }

    idempotencyCacheHitsTotal.labels(operationType).inc();
    indexLogger.info({
      idempotencyKey,
      operationType,
      cacheHit: true
    }, 'Idempotency cache hit');

    return { ...cached.result, replayed: true };
  }

  // Mark as in progress
  const marked = await store.markInProgress(idempotencyKey);
  if (!marked) {
    throw new Error('Operation with this idempotency key is being processed');
  }

  try {
    const result = await operation();

    // Cache the result
    await store.set(idempotencyKey, result);

    indexLogger.info({
      idempotencyKey,
      operationType,
      cached: true
    }, 'Idempotency result cached');

    return result;
  } catch (error) {
    // Remove from cache on failure so operation can be retried
    await store.remove(idempotencyKey);
    throw error;
  }
}

/**
 * Get the idempotency store (for testing/monitoring)
 * @returns {IdempotencyStore} - The store instance
 */
export function getIdempotencyStore() {
  return store;
}

/**
 * Clear the idempotency store (for testing)
 */
export async function clearIdempotencyStore() {
  const keys = await redis.keys('idempotency:*');
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

export default {
  generateIdempotencyKey,
  idempotencyMiddleware,
  withIdempotency,
  getIdempotencyStore,
  clearIdempotencyStore
};
