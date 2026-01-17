import crypto from 'crypto';
import { idempotencyCacheHitsTotal } from './metrics.js';
import { indexLogger } from './logger.js';

/**
 * In-memory idempotency store
 * In production, this should use Redis/Valkey for distributed deployments
 */
class IdempotencyStore {
  constructor() {
    // Map of idempotencyKey -> { result, timestamp, status }
    this.cache = new Map();
    // Default TTL: 24 hours
    this.ttl = 24 * 60 * 60 * 1000;
    // Clean up expired entries every hour
    this.cleanupInterval = setInterval(() => this.cleanup(), 60 * 60 * 1000);
  }

  /**
   * Get a cached result for an idempotency key
   * @param {string} key - Idempotency key
   * @returns {Object|null} - Cached result or null
   */
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }

    // Check if expired
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry;
  }

  /**
   * Set a result for an idempotency key
   * @param {string} key - Idempotency key
   * @param {Object} result - Result to cache
   * @param {string} status - Status of the operation
   */
  set(key, result, status = 'completed') {
    this.cache.set(key, {
      result,
      status,
      timestamp: Date.now()
    });
  }

  /**
   * Mark an operation as in-progress
   * @param {string} key - Idempotency key
   * @returns {boolean} - True if successfully marked, false if already in progress
   */
  markInProgress(key) {
    const existing = this.get(key);
    if (existing) {
      return false; // Already exists
    }

    this.cache.set(key, {
      result: null,
      status: 'in_progress',
      timestamp: Date.now()
    });
    return true;
  }

  /**
   * Remove an idempotency key (for failed operations that should be retried)
   * @param {string} key - Idempotency key
   */
  remove(key) {
    this.cache.delete(key);
  }

  /**
   * Clean up expired entries
   */
  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp > this.ttl) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Get the number of cached entries
   * @returns {number} - Number of entries
   */
  size() {
    return this.cache.size;
  }

  /**
   * Stop the cleanup interval (for graceful shutdown)
   */
  stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
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
    const cached = store.get(idempotencyKey);

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
    if (!store.markInProgress(idempotencyKey)) {
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
    res.on('finish', () => {
      if (responseBody !== null) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          // Only cache successful responses
          store.set(idempotencyKey, {
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
          store.remove(idempotencyKey);
        }
      } else {
        // No response body, remove from cache
        store.remove(idempotencyKey);
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
  const cached = store.get(idempotencyKey);

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
  if (!store.markInProgress(idempotencyKey)) {
    throw new Error('Operation with this idempotency key is being processed');
  }

  try {
    const result = await operation();

    // Cache the result
    store.set(idempotencyKey, result);

    indexLogger.info({
      idempotencyKey,
      operationType,
      cached: true
    }, 'Idempotency result cached');

    return result;
  } catch (error) {
    // Remove from cache on failure so operation can be retried
    store.remove(idempotencyKey);
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
export function clearIdempotencyStore() {
  store.cache.clear();
}

export default {
  generateIdempotencyKey,
  idempotencyMiddleware,
  withIdempotency,
  getIdempotencyStore,
  clearIdempotencyStore
};
