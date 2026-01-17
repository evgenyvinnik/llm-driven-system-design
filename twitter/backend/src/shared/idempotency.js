import { v4 as uuidv4 } from 'uuid';
import logger from './logger.js';
import { idempotencyHits, idempotencyMisses } from './metrics.js';

/**
 * Idempotency Middleware
 *
 * Prevents duplicate operations when clients retry requests.
 *
 * How it works:
 * 1. Client sends request with unique Idempotency-Key header
 * 2. Server checks if key exists in Redis cache
 * 3. If found: return cached response (request already processed)
 * 4. If not found: process request, cache response, return result
 *
 * This prevents issues like:
 * - Double tweets when user clicks "Tweet" twice
 * - Duplicate follows from network retry
 * - Multiple likes from retry after timeout
 */

const DEFAULT_OPTIONS = {
  ttlSeconds: 86400, // 24 hours
  keyPrefix: 'idempotency',
  headerName: 'Idempotency-Key',
};

/**
 * Create idempotency middleware for a specific operation
 *
 * @param {object} redis - Redis client
 * @param {string} operationType - Type of operation (e.g., 'tweet', 'follow')
 * @param {object} options - Configuration options
 * @returns {Function} Express middleware
 */
export function createIdempotencyMiddleware(redis, operationType, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };

  return async function idempotencyMiddleware(req, res, next) {
    const idempotencyKey = req.headers[config.headerName.toLowerCase()];

    // If no idempotency key provided, generate one (optional behavior)
    // For stricter enforcement, you could return 400 here instead
    if (!idempotencyKey) {
      // For non-idempotent operations, proceed without caching
      req.idempotencyKey = null;
      return next();
    }

    // Validate key format (should be UUID or similar)
    if (idempotencyKey.length > 100) {
      return res.status(400).json({
        error: 'Idempotency key too long (max 100 characters)',
      });
    }

    // Build cache key with user context to prevent cross-user conflicts
    const userId = req.session?.userId || 'anonymous';
    const cacheKey = `${config.keyPrefix}:${operationType}:${userId}:${idempotencyKey}`;

    try {
      // Check if we've already processed this request
      const cachedResponse = await redis.get(cacheKey);

      if (cachedResponse) {
        logger.info(
          {
            idempotencyKey,
            operationType,
            userId,
            action: 'cache_hit',
          },
          'Idempotency cache hit - returning cached response',
        );

        idempotencyHits.inc();

        // Return the cached response
        const parsed = JSON.parse(cachedResponse);
        return res.status(parsed.statusCode).json(parsed.body);
      }

      idempotencyMisses.inc();

      // Store the idempotency key and cache key for later use
      req.idempotencyKey = idempotencyKey;
      req.idempotencyCacheKey = cacheKey;
      req.idempotencyTtl = config.ttlSeconds;

      // Intercept the response to cache it
      const originalJson = res.json.bind(res);
      res.json = function (body) {
        // Only cache successful responses (2xx)
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const responseToCache = {
            statusCode: res.statusCode,
            body,
            cachedAt: new Date().toISOString(),
          };

          // Cache the response (fire and forget)
          redis
            .setex(cacheKey, config.ttlSeconds, JSON.stringify(responseToCache))
            .catch((err) => {
              logger.warn(
                {
                  error: err.message,
                  cacheKey,
                },
                'Failed to cache idempotency response',
              );
            });

          logger.debug(
            {
              idempotencyKey,
              operationType,
              userId,
              action: 'cached',
            },
            'Cached idempotency response',
          );
        }

        return originalJson(body);
      };

      next();
    } catch (error) {
      logger.error(
        {
          error: error.message,
          idempotencyKey,
          operationType,
        },
        'Idempotency middleware error',
      );

      // On Redis error, proceed without idempotency (degraded mode)
      // Better to allow potential duplicates than block all requests
      next();
    }
  };
}

/**
 * Pre-configured idempotency middleware factories
 */

/**
 * Idempotency middleware for tweet creation
 */
export function tweetIdempotencyMiddleware(redis) {
  return createIdempotencyMiddleware(redis, 'tweet', {
    ttlSeconds: 86400, // 24 hours
  });
}

/**
 * Idempotency middleware for follow operations
 */
export function followIdempotencyMiddleware(redis) {
  return createIdempotencyMiddleware(redis, 'follow', {
    ttlSeconds: 3600, // 1 hour (follows are less likely to be retried long after)
  });
}

/**
 * Idempotency middleware for like operations
 */
export function likeIdempotencyMiddleware(redis) {
  return createIdempotencyMiddleware(redis, 'like', {
    ttlSeconds: 3600, // 1 hour
  });
}

/**
 * Idempotency middleware for retweet operations
 */
export function retweetIdempotencyMiddleware(redis) {
  return createIdempotencyMiddleware(redis, 'retweet', {
    ttlSeconds: 3600, // 1 hour
  });
}

/**
 * Generate a new idempotency key (for clients that don't provide one)
 *
 * @returns {string} UUID v4
 */
export function generateIdempotencyKey() {
  return uuidv4();
}

/**
 * Manually check if an idempotency key exists
 *
 * @param {object} redis - Redis client
 * @param {string} operationType - Type of operation
 * @param {string} userId - User ID
 * @param {string} idempotencyKey - The idempotency key
 * @returns {Promise<object|null>} Cached response or null
 */
export async function checkIdempotencyKey(redis, operationType, userId, idempotencyKey) {
  const cacheKey = `${DEFAULT_OPTIONS.keyPrefix}:${operationType}:${userId}:${idempotencyKey}`;
  const cached = await redis.get(cacheKey);
  return cached ? JSON.parse(cached) : null;
}

export default {
  createIdempotencyMiddleware,
  tweetIdempotencyMiddleware,
  followIdempotencyMiddleware,
  likeIdempotencyMiddleware,
  retweetIdempotencyMiddleware,
  generateIdempotencyKey,
  checkIdempotencyKey,
};
