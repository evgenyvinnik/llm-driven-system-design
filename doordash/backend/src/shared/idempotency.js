import redisClient from '../redis.js';
import logger from './logger.js';
import { idempotencyHits } from './metrics.js';

/**
 * Default TTL for idempotency keys (24 hours)
 */
const DEFAULT_TTL = 86400;

/**
 * Idempotency key prefixes
 */
export const IDEMPOTENCY_KEYS = {
  ORDER_CREATE: 'idempotency:order:create:',
  PAYMENT: 'idempotency:payment:',
  STATUS_CHANGE: 'idempotency:status:',
};

/**
 * Response status indicating idempotency state
 */
export const IdempotencyStatus = {
  NEW: 'new', // First request with this key
  IN_PROGRESS: 'in_progress', // Request is being processed
  COMPLETED: 'completed', // Request completed, returning cached response
};

/**
 * Check if an idempotency key exists and get cached response
 * @param {string} prefix - Key prefix (from IDEMPOTENCY_KEYS)
 * @param {string} key - Idempotency key (usually from X-Idempotency-Key header)
 * @returns {Object} { status, response }
 */
export async function checkIdempotency(prefix, key) {
  if (!key) {
    return { status: IdempotencyStatus.NEW, response: null };
  }

  const fullKey = `${prefix}${key}`;

  try {
    const cached = await redisClient.get(fullKey);

    if (!cached) {
      // No existing request with this key
      return { status: IdempotencyStatus.NEW, response: null };
    }

    const data = JSON.parse(cached);

    if (data.inProgress) {
      // Request is still being processed
      return { status: IdempotencyStatus.IN_PROGRESS, response: null };
    }

    // Request completed, return cached response
    idempotencyHits.inc({ operation: prefix.replace(/^idempotency:|:$/g, '') });
    logger.info({ key: fullKey }, 'Idempotency cache hit - returning cached response');

    return {
      status: IdempotencyStatus.COMPLETED,
      response: data.response,
    };
  } catch (error) {
    logger.warn({ error: error.message, key: fullKey }, 'Idempotency check error');
    // On error, treat as new request
    return { status: IdempotencyStatus.NEW, response: null };
  }
}

/**
 * Mark an idempotency key as in-progress
 * This prevents duplicate processing if a second request arrives before the first completes
 * @param {string} prefix - Key prefix
 * @param {string} key - Idempotency key
 * @param {number} ttl - TTL in seconds (default 60 for in-progress)
 * @returns {boolean} True if successfully marked, false if key already exists
 */
export async function markInProgress(prefix, key, ttl = 60) {
  if (!key) return true;

  const fullKey = `${prefix}${key}`;

  try {
    // Use NX (only set if not exists) to prevent race conditions
    const result = await redisClient.set(
      fullKey,
      JSON.stringify({ inProgress: true, startedAt: Date.now() }),
      { NX: true, EX: ttl }
    );

    return result !== null;
  } catch (error) {
    logger.warn({ error: error.message, key: fullKey }, 'Failed to mark idempotency in-progress');
    return true; // Allow processing on error
  }
}

/**
 * Store the completed response for an idempotency key
 * @param {string} prefix - Key prefix
 * @param {string} key - Idempotency key
 * @param {Object} response - Response to cache { statusCode, body }
 * @param {number} ttl - TTL in seconds (default 24 hours)
 */
export async function storeIdempotencyResponse(prefix, key, response, ttl = DEFAULT_TTL) {
  if (!key) return;

  const fullKey = `${prefix}${key}`;

  try {
    await redisClient.setEx(
      fullKey,
      ttl,
      JSON.stringify({
        inProgress: false,
        response,
        completedAt: Date.now(),
      })
    );

    logger.debug({ key: fullKey }, 'Idempotency response stored');
  } catch (error) {
    logger.warn({ error: error.message, key: fullKey }, 'Failed to store idempotency response');
  }
}

/**
 * Clear an idempotency key (used when request fails and should be retryable)
 * @param {string} prefix - Key prefix
 * @param {string} key - Idempotency key
 */
export async function clearIdempotencyKey(prefix, key) {
  if (!key) return;

  const fullKey = `${prefix}${key}`;

  try {
    await redisClient.del(fullKey);
    logger.debug({ key: fullKey }, 'Idempotency key cleared');
  } catch (error) {
    logger.warn({ error: error.message, key: fullKey }, 'Failed to clear idempotency key');
  }
}

/**
 * Express middleware to enforce idempotency for a specific operation
 * @param {string} prefix - Key prefix for this operation
 * @returns {Function} Express middleware
 */
export function idempotencyMiddleware(prefix) {
  return async (req, res, next) => {
    const idempotencyKey = req.headers['x-idempotency-key'];

    if (!idempotencyKey) {
      // Idempotency key required for this operation
      return res.status(400).json({
        error: 'Missing X-Idempotency-Key header',
        message: 'This operation requires an idempotency key to prevent duplicate processing',
      });
    }

    // Check for existing request
    const { status, response } = await checkIdempotency(prefix, idempotencyKey);

    if (status === IdempotencyStatus.COMPLETED) {
      // Return cached response
      return res.status(response.statusCode).json(response.body);
    }

    if (status === IdempotencyStatus.IN_PROGRESS) {
      // Request is already being processed
      return res.status(409).json({
        error: 'Request in progress',
        message: 'A request with this idempotency key is currently being processed',
      });
    }

    // Mark as in-progress
    const marked = await markInProgress(prefix, idempotencyKey);
    if (!marked) {
      // Race condition - another request started processing
      return res.status(409).json({
        error: 'Request in progress',
        message: 'A request with this idempotency key is currently being processed',
      });
    }

    // Attach idempotency key to request for later storage
    req.idempotencyKey = idempotencyKey;
    req.idempotencyPrefix = prefix;

    // Wrap res.json to capture and store the response
    const originalJson = res.json.bind(res);
    res.json = async (body) => {
      // Store response for future identical requests
      await storeIdempotencyResponse(prefix, idempotencyKey, {
        statusCode: res.statusCode,
        body,
      });
      return originalJson(body);
    };

    next();
  };
}

export default {
  IDEMPOTENCY_KEYS,
  IdempotencyStatus,
  checkIdempotency,
  markInProgress,
  storeIdempotencyResponse,
  clearIdempotencyKey,
  idempotencyMiddleware,
};
