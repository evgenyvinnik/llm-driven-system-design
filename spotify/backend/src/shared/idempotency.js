import { redisClient } from '../db.js';
import logger from './logger.js';
import { idempotencyDeduplicationsTotal } from './metrics.js';

/**
 * Idempotency handling for playlist modifications.
 * Prevents duplicate operations from network retries or client bugs.
 *
 * Uses Redis for distributed deduplication with configurable TTL.
 */

const DEFAULT_TTL_SECONDS = 300; // 5 minutes

/**
 * Check if an operation has already been processed.
 * If not, mark it as in-progress.
 *
 * @param {string} key - Idempotency key (e.g., request ID or composite key)
 * @param {string} operation - Operation name for metrics
 * @param {number} ttlSeconds - TTL for the idempotency record
 * @returns {Promise<{isDuplicate: boolean, cachedResult: any}>}
 */
export async function checkIdempotency(key, operation, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const fullKey = `idempotency:${key}`;

  try {
    // Try to set the key with NX (only if not exists)
    const acquired = await redisClient.set(fullKey, JSON.stringify({ status: 'processing' }), {
      NX: true,
      EX: ttlSeconds,
    });

    if (acquired) {
      // First time seeing this key
      return { isDuplicate: false, cachedResult: null };
    }

    // Key exists - check its status
    const existing = await redisClient.get(fullKey);
    if (!existing) {
      // Key expired between check and get
      return { isDuplicate: false, cachedResult: null };
    }

    const data = JSON.parse(existing);

    if (data.status === 'processing') {
      // Another request is still processing
      logger.warn({ key, operation }, 'Concurrent duplicate request detected');
      return { isDuplicate: true, cachedResult: null };
    }

    // Previous request completed - return cached result
    idempotencyDeduplicationsTotal.inc({ operation });
    logger.info({ key, operation }, 'Returning cached idempotent result');
    return { isDuplicate: true, cachedResult: data.result };
  } catch (error) {
    logger.error({ error, key, operation }, 'Idempotency check failed');
    // On error, proceed with the request (fail open)
    return { isDuplicate: false, cachedResult: null };
  }
}

/**
 * Store the result of an idempotent operation.
 *
 * @param {string} key - Idempotency key
 * @param {any} result - Result to cache
 * @param {number} ttlSeconds - TTL for the result
 */
export async function storeIdempotencyResult(key, result, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const fullKey = `idempotency:${key}`;

  try {
    await redisClient.set(
      fullKey,
      JSON.stringify({ status: 'completed', result }),
      { EX: ttlSeconds }
    );
  } catch (error) {
    logger.error({ error, key }, 'Failed to store idempotency result');
  }
}

/**
 * Middleware factory for idempotent operations.
 * Expects `X-Idempotency-Key` header or generates one from request body hash.
 *
 * @param {string} operation - Operation name for logging/metrics
 * @param {Function} keyGenerator - Optional custom key generator function
 */
export function idempotencyMiddleware(operation, keyGenerator = null) {
  return async (req, res, next) => {
    // Get idempotency key from header or generate from request
    let idempotencyKey = req.headers['x-idempotency-key'];

    if (!idempotencyKey && keyGenerator) {
      idempotencyKey = keyGenerator(req);
    }

    if (!idempotencyKey) {
      // No idempotency key provided - proceed normally
      return next();
    }

    // Include user ID in key to prevent cross-user conflicts
    const fullKey = `${operation}:${req.session?.userId || 'anon'}:${idempotencyKey}`;

    const { isDuplicate, cachedResult } = await checkIdempotency(fullKey, operation);

    if (isDuplicate) {
      if (cachedResult !== null) {
        // Return cached result
        return res.json(cachedResult);
      }
      // Request still processing
      return res.status(409).json({
        error: 'Request already in progress',
        idempotencyKey,
      });
    }

    // Store key and operation info on request for later result storage
    req.idempotencyKey = fullKey;
    req.idempotencyOperation = operation;

    // Wrap res.json to capture result
    const originalJson = res.json.bind(res);
    res.json = async (body) => {
      // Store result for future duplicate requests
      if (res.statusCode >= 200 && res.statusCode < 300) {
        await storeIdempotencyResult(fullKey, body);
      }
      return originalJson(body);
    };

    next();
  };
}

/**
 * Generate idempotency key for playlist track operations.
 * Uses playlist ID, track ID, and operation type.
 */
export function playlistTrackIdempotencyKey(req) {
  const playlistId = req.params.id;
  const trackId = req.body?.trackId || req.params.trackId;
  const operation = req.method;
  return `${playlistId}:${trackId}:${operation}`;
}

export default {
  checkIdempotency,
  storeIdempotencyResult,
  idempotencyMiddleware,
  playlistTrackIdempotencyKey,
};
