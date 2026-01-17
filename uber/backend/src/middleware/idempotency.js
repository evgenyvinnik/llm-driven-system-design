import redis from './redis.js';
import { createLogger } from './logger.js';
import { metrics } from './metrics.js';

const logger = createLogger('idempotency');

const IDEMPOTENCY_PREFIX = 'idempotency:';
const PENDING_MARKER = 'pending';
const DEFAULT_TTL = 86400; // 24 hours
const PENDING_TTL = 60; // 60 seconds for in-flight requests

/**
 * Idempotency middleware factory
 * Prevents duplicate requests by caching responses for a given idempotency key
 *
 * @param {Object} options - Middleware options
 * @param {string} options.operation - Name of the operation for metrics
 * @param {number} options.ttl - TTL for cached responses in seconds
 * @returns {Function} Express middleware
 */
export function idempotencyMiddleware(options = {}) {
  const { operation = 'unknown', ttl = DEFAULT_TTL } = options;

  return async (req, res, next) => {
    // Get idempotency key from header
    const idempotencyKey = req.headers['x-idempotency-key'];

    // If no idempotency key, proceed normally
    if (!idempotencyKey) {
      return next();
    }

    // Validate idempotency key format (should be UUID-like)
    if (!/^[a-zA-Z0-9-]{8,64}$/.test(idempotencyKey)) {
      return res.status(400).json({
        error: 'Invalid idempotency key format. Must be 8-64 alphanumeric characters.',
      });
    }

    // Create cache key with user context to prevent cross-user collisions
    const userId = req.user?.id || 'anonymous';
    const cacheKey = `${IDEMPOTENCY_PREFIX}${operation}:${userId}:${idempotencyKey}`;

    try {
      // Check if request was already processed
      const cached = await redis.get(cacheKey);

      if (cached) {
        if (cached === PENDING_MARKER) {
          // Request is currently being processed
          logger.warn(
            { operation, idempotencyKey, userId },
            'Duplicate request while original is still processing'
          );
          metrics.idempotencyHits.inc({ operation });
          return res.status(409).json({
            error: 'Request with this idempotency key is currently being processed',
            retryAfter: 5,
          });
        }

        // Return cached response
        try {
          const { statusCode, body } = JSON.parse(cached);
          logger.info(
            { operation, idempotencyKey, userId, statusCode },
            'Returning cached idempotent response'
          );
          metrics.idempotencyHits.inc({ operation });
          return res.status(statusCode).json(body);
        } catch (parseError) {
          // If we can't parse the cached response, delete it and proceed
          logger.error(
            { operation, idempotencyKey, error: parseError.message },
            'Failed to parse cached response, clearing'
          );
          await redis.del(cacheKey);
        }
      }

      metrics.idempotencyMisses.inc({ operation });

      // Set pending marker to prevent concurrent duplicate requests
      const acquired = await redis.set(cacheKey, PENDING_MARKER, 'NX', 'EX', PENDING_TTL);

      if (!acquired) {
        // Another request with the same key started just now
        logger.warn(
          { operation, idempotencyKey, userId },
          'Race condition: concurrent request with same idempotency key'
        );
        return res.status(409).json({
          error: 'Request with this idempotency key is currently being processed',
          retryAfter: 5,
        });
      }

      // Store original response methods
      const originalJson = res.json.bind(res);
      const originalSend = res.send.bind(res);

      // Override response methods to capture and cache the response
      const cacheResponse = async (body) => {
        try {
          const responseData = {
            statusCode: res.statusCode,
            body: typeof body === 'string' ? JSON.parse(body) : body,
            cachedAt: Date.now(),
          };

          // Cache the response
          await redis.set(cacheKey, JSON.stringify(responseData), 'EX', ttl);

          logger.debug(
            { operation, idempotencyKey, userId, statusCode: res.statusCode },
            'Cached idempotent response'
          );
        } catch (cacheError) {
          // Log but don't fail the request if caching fails
          logger.error(
            { operation, idempotencyKey, error: cacheError.message },
            'Failed to cache idempotent response'
          );
        }
      };

      res.json = async function (body) {
        await cacheResponse(body);
        return originalJson(body);
      };

      res.send = async function (body) {
        if (typeof body === 'object') {
          await cacheResponse(body);
        }
        return originalSend(body);
      };

      // Clean up pending marker on error
      res.on('close', async () => {
        if (!res.writableEnded) {
          // Request was aborted, clean up pending marker
          await redis.del(cacheKey);
        }
      });

      next();
    } catch (error) {
      logger.error(
        { operation, idempotencyKey, error: error.message },
        'Idempotency middleware error'
      );

      // If Redis fails, proceed without idempotency (fail open)
      next();
    }
  };
}

/**
 * Check if a request with given idempotency key has already been processed
 * @param {string} operation - Operation name
 * @param {string} userId - User ID
 * @param {string} idempotencyKey - Idempotency key
 * @returns {Promise<Object|null>} Cached response or null
 */
export async function getIdempotentResponse(operation, userId, idempotencyKey) {
  const cacheKey = `${IDEMPOTENCY_PREFIX}${operation}:${userId}:${idempotencyKey}`;

  try {
    const cached = await redis.get(cacheKey);

    if (cached && cached !== PENDING_MARKER) {
      return JSON.parse(cached);
    }

    return null;
  } catch (error) {
    logger.error({ operation, idempotencyKey, error: error.message }, 'Failed to get idempotent response');
    return null;
  }
}

/**
 * Manually set an idempotent response
 * Useful for background operations that need idempotency
 * @param {string} operation - Operation name
 * @param {string} userId - User ID
 * @param {string} idempotencyKey - Idempotency key
 * @param {Object} response - Response to cache
 * @param {number} ttl - TTL in seconds
 */
export async function setIdempotentResponse(operation, userId, idempotencyKey, response, ttl = DEFAULT_TTL) {
  const cacheKey = `${IDEMPOTENCY_PREFIX}${operation}:${userId}:${idempotencyKey}`;

  try {
    const responseData = {
      statusCode: response.statusCode || 200,
      body: response.body,
      cachedAt: Date.now(),
    };

    await redis.set(cacheKey, JSON.stringify(responseData), 'EX', ttl);

    logger.debug({ operation, idempotencyKey, userId }, 'Set idempotent response');
  } catch (error) {
    logger.error({ operation, idempotencyKey, error: error.message }, 'Failed to set idempotent response');
  }
}

/**
 * Clear an idempotent response
 * @param {string} operation - Operation name
 * @param {string} userId - User ID
 * @param {string} idempotencyKey - Idempotency key
 */
export async function clearIdempotentResponse(operation, userId, idempotencyKey) {
  const cacheKey = `${IDEMPOTENCY_PREFIX}${operation}:${userId}:${idempotencyKey}`;

  try {
    await redis.del(cacheKey);
    logger.debug({ operation, idempotencyKey, userId }, 'Cleared idempotent response');
  } catch (error) {
    logger.error({ operation, idempotencyKey, error: error.message }, 'Failed to clear idempotent response');
  }
}

export default {
  idempotencyMiddleware,
  getIdempotentResponse,
  setIdempotentResponse,
  clearIdempotentResponse,
};
