import redis from '../services/redis.js';
import { idempotencyKeyHits } from './metrics.js';
import { createLogger } from './logger.js';

const logger = createLogger('idempotency');

// Idempotency key TTL in seconds (24 hours by default)
const IDEMPOTENCY_KEY_TTL = 24 * 60 * 60;

// Key prefix for idempotency storage
const IDEMPOTENCY_PREFIX = 'idempotency:';

// Possible states for idempotency keys
const IdempotencyState = {
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

/**
 * Check if an idempotency key exists and get its result
 * @param {string} key - The idempotency key (usually from Idempotency-Key header)
 * @returns {Promise<{exists: boolean, state?: string, result?: any}>}
 */
export async function checkIdempotencyKey(key) {
  try {
    const data = await redis.get(`${IDEMPOTENCY_PREFIX}${key}`);
    if (!data) {
      return { exists: false };
    }

    const parsed = JSON.parse(data);
    idempotencyKeyHits.inc();
    logger.info({ key, state: parsed.state }, 'Idempotency key hit');

    return {
      exists: true,
      state: parsed.state,
      result: parsed.result,
      statusCode: parsed.statusCode,
    };
  } catch (error) {
    logger.error({ error, key }, 'Error checking idempotency key');
    return { exists: false };
  }
}

/**
 * Start processing for an idempotency key
 * Acquires a lock to prevent concurrent processing
 * @param {string} key - The idempotency key
 * @param {number} lockTtl - Lock TTL in seconds (default 60s)
 * @returns {Promise<boolean>} True if lock acquired, false if already processing
 */
export async function startIdempotentOperation(key, lockTtl = 60) {
  try {
    const fullKey = `${IDEMPOTENCY_PREFIX}${key}`;

    // Try to set with NX (only if not exists)
    const acquired = await redis.set(
      fullKey,
      JSON.stringify({ state: IdempotencyState.PROCESSING, startedAt: new Date().toISOString() }),
      'EX',
      lockTtl,
      'NX'
    );

    if (acquired) {
      logger.info({ key }, 'Idempotent operation started');
      return true;
    }

    logger.debug({ key }, 'Idempotent operation already in progress');
    return false;
  } catch (error) {
    logger.error({ error, key }, 'Error starting idempotent operation');
    return false;
  }
}

/**
 * Complete an idempotent operation with its result
 * @param {string} key - The idempotency key
 * @param {any} result - The result to store
 * @param {number} statusCode - HTTP status code of the response
 * @param {number} ttl - TTL for storing the result (default 24h)
 */
export async function completeIdempotentOperation(key, result, statusCode = 200, ttl = IDEMPOTENCY_KEY_TTL) {
  try {
    const fullKey = `${IDEMPOTENCY_PREFIX}${key}`;
    const data = {
      state: IdempotencyState.COMPLETED,
      result,
      statusCode,
      completedAt: new Date().toISOString(),
    };

    await redis.setex(fullKey, ttl, JSON.stringify(data));
    logger.info({ key, statusCode }, 'Idempotent operation completed');
  } catch (error) {
    logger.error({ error, key }, 'Error completing idempotent operation');
  }
}

/**
 * Mark an idempotent operation as failed
 * Clears the key so it can be retried
 * @param {string} key - The idempotency key
 * @param {string} error - Error message
 */
export async function failIdempotentOperation(key, error) {
  try {
    const fullKey = `${IDEMPOTENCY_PREFIX}${key}`;
    // Delete the key to allow retry
    await redis.del(fullKey);
    logger.warn({ key, error }, 'Idempotent operation failed, key cleared for retry');
  } catch (err) {
    logger.error({ error: err, key }, 'Error failing idempotent operation');
  }
}

/**
 * Express middleware for idempotency
 * Requires Idempotency-Key header for POST/PUT/DELETE requests
 * @param {Object} options - Middleware options
 * @param {boolean} options.required - Whether idempotency key is required
 * @param {string[]} options.methods - HTTP methods to enforce (default: POST)
 * @returns {Function} Express middleware
 */
export function idempotencyMiddleware(options = {}) {
  const { required = false, methods = ['POST'] } = options;

  return async (req, res, next) => {
    // Only check specified methods
    if (!methods.includes(req.method)) {
      return next();
    }

    const idempotencyKey = req.headers['idempotency-key'];

    // If no key provided
    if (!idempotencyKey) {
      if (required) {
        return res.status(400).json({
          error: 'Idempotency-Key header is required for this request',
        });
      }
      return next();
    }

    // Check if key already exists
    const existing = await checkIdempotencyKey(idempotencyKey);

    if (existing.exists) {
      if (existing.state === IdempotencyState.PROCESSING) {
        // Request is still being processed
        return res.status(409).json({
          error: 'Request with this idempotency key is still being processed',
          retryAfter: 5,
        });
      }

      if (existing.state === IdempotencyState.COMPLETED) {
        // Return cached result
        logger.info({ key: idempotencyKey }, 'Returning cached idempotent response');
        return res.status(existing.statusCode).json(existing.result);
      }
    }

    // Try to acquire lock
    const acquired = await startIdempotentOperation(idempotencyKey);
    if (!acquired) {
      return res.status(409).json({
        error: 'Concurrent request with same idempotency key detected',
        retryAfter: 5,
      });
    }

    // Store key on request for later use
    req.idempotencyKey = idempotencyKey;

    // Wrap res.json to capture the response
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      // Store the result if successful
      if (res.statusCode >= 200 && res.statusCode < 300) {
        completeIdempotentOperation(idempotencyKey, data, res.statusCode).catch((err) => {
          logger.error({ error: err }, 'Failed to complete idempotent operation');
        });
      } else {
        // Failed request, allow retry
        failIdempotentOperation(idempotencyKey, 'Request failed').catch((err) => {
          logger.error({ error: err }, 'Failed to fail idempotent operation');
        });
      }
      return originalJson(data);
    };

    next();
  };
}

/**
 * Generate an idempotency key for client-side use
 * Based on user ID and operation details
 * @param {number} userId - User ID
 * @param {string} operation - Operation type (e.g., 'checkout')
 * @param {string} details - Additional details (e.g., cart hash)
 * @returns {string} Generated idempotency key
 */
export function generateIdempotencyKey(userId, operation, details = '') {
  const timestamp = Math.floor(Date.now() / 60000); // 1-minute granularity
  return `${userId}:${operation}:${details}:${timestamp}`;
}

export default {
  checkIdempotencyKey,
  startIdempotentOperation,
  completeIdempotentOperation,
  failIdempotentOperation,
  idempotencyMiddleware,
  generateIdempotencyKey,
  IdempotencyState,
};
