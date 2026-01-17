/**
 * Idempotency middleware for safe request retries
 *
 * Provides idempotency for mutating operations to handle:
 * - Network failures causing client retries
 * - Duplicate form submissions
 * - Mobile app background retry behavior
 *
 * Uses Redis to store request results with TTL.
 * Clients send an Idempotency-Key header to enable this behavior.
 */
const { v4: uuid } = require('uuid');
const { logger } = require('./logger');
const { idempotentRequestsTotal } = require('./metrics');

// TTL for idempotency records (24 hours)
const IDEMPOTENCY_TTL = 86400;
// Lock TTL to prevent concurrent processing (30 seconds)
const LOCK_TTL = 30;

/**
 * Express middleware for idempotent request handling
 *
 * @param {Object} redis - Redis client
 * @returns {Function} Express middleware
 */
function idempotencyMiddleware(redis) {
  return async (req, res, next) => {
    // Only apply to mutating methods
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      return next();
    }

    const idempotencyKey = req.headers['idempotency-key'];

    // If no idempotency key, proceed normally
    if (!idempotencyKey) {
      return next();
    }

    const userId = req.session?.userId || 'anonymous';
    const cacheKey = `idempotency:${userId}:${idempotencyKey}`;
    const lockKey = `${cacheKey}:lock`;

    try {
      // Check if we already have a cached response
      const cached = await redis.get(cacheKey);
      if (cached) {
        const response = JSON.parse(cached);
        idempotentRequestsTotal.inc({ result: 'cached' });

        if (req.log) {
          req.log.info({
            idempotencyKey,
            cachedStatus: response.status
          }, 'Returning cached idempotent response');
        }

        return res.status(response.status).json(response.body);
      }

      // Try to acquire lock for processing
      const lockAcquired = await redis.set(lockKey, '1', {
        NX: true,
        EX: LOCK_TTL
      });

      if (!lockAcquired) {
        // Another request is processing this idempotency key
        idempotentRequestsTotal.inc({ result: 'in_progress' });
        return res.status(409).json({
          error: 'Request already in progress',
          idempotencyKey
        });
      }

      // Store original response methods
      const originalJson = res.json.bind(res);
      const originalSend = res.send.bind(res);

      // Override json method to cache the response
      res.json = async (body) => {
        try {
          // Cache the response
          await redis.setEx(cacheKey, IDEMPOTENCY_TTL, JSON.stringify({
            status: res.statusCode,
            body
          }));
          // Release lock
          await redis.del(lockKey);
          idempotentRequestsTotal.inc({ result: 'new' });
        } catch (cacheError) {
          logger.error({
            error: cacheError.message,
            idempotencyKey
          }, 'Failed to cache idempotent response');
        }

        return originalJson(body);
      };

      // Override send method similarly
      res.send = async (body) => {
        try {
          // Only cache JSON responses
          if (res.get('Content-Type')?.includes('application/json')) {
            await redis.setEx(cacheKey, IDEMPOTENCY_TTL, JSON.stringify({
              status: res.statusCode,
              body: typeof body === 'string' ? JSON.parse(body) : body
            }));
          }
          await redis.del(lockKey);
        } catch (cacheError) {
          logger.error({
            error: cacheError.message,
            idempotencyKey
          }, 'Failed to cache idempotent response');
        }

        return originalSend(body);
      };

      next();
    } catch (error) {
      logger.error({
        error: error.message,
        idempotencyKey
      }, 'Idempotency middleware error');

      // On error, proceed without idempotency protection
      next();
    }
  };
}

/**
 * Create an idempotency key for a specific operation
 * Useful for server-side idempotency (e.g., background jobs)
 *
 * @param {string} operation - Operation name
 * @param {...string} parts - Additional key parts
 * @returns {string} Idempotency key
 */
function createIdempotencyKey(operation, ...parts) {
  return `${operation}:${parts.join(':')}:${uuid()}`;
}

/**
 * Check if an operation has already been performed (idempotent check)
 *
 * @param {Object} redis - Redis client
 * @param {string} key - Idempotency key
 * @returns {Promise<Object|null>} Cached result or null
 */
async function checkIdempotency(redis, key) {
  const cached = await redis.get(`idempotency:${key}`);
  return cached ? JSON.parse(cached) : null;
}

/**
 * Mark an operation as completed (idempotent store)
 *
 * @param {Object} redis - Redis client
 * @param {string} key - Idempotency key
 * @param {Object} result - Operation result to cache
 * @param {number} ttl - TTL in seconds (default 24 hours)
 */
async function markIdempotent(redis, key, result, ttl = IDEMPOTENCY_TTL) {
  await redis.setEx(`idempotency:${key}`, ttl, JSON.stringify(result));
}

/**
 * Middleware specifically for watch progress updates
 * Uses content-based idempotency with timestamp comparison
 *
 * @param {Object} redis - Redis client
 * @returns {Function} Express middleware
 */
function watchProgressIdempotency(redis) {
  return async (req, res, next) => {
    if (req.method !== 'POST') {
      return next();
    }

    const { contentId } = req.params;
    const profileId = req.session?.profileId;
    const { position, clientTimestamp } = req.body;

    if (!profileId || !contentId) {
      return next();
    }

    // Create a deterministic key based on the update parameters
    const idempotencyKey = `progress:${profileId}:${contentId}`;

    try {
      // Get last update info
      const lastUpdate = await redis.get(idempotencyKey);

      if (lastUpdate) {
        const parsed = JSON.parse(lastUpdate);

        // If client timestamp is older or equal, skip update
        if (clientTimestamp && parsed.clientTimestamp >= clientTimestamp) {
          if (req.log) {
            req.log.info({
              contentId,
              profileId,
              clientTimestamp,
              lastTimestamp: parsed.clientTimestamp
            }, 'Skipping stale progress update');
          }

          return res.json({
            success: true,
            skipped: true,
            reason: 'stale_update'
          });
        }
      }

      // Store the update info for future comparisons (short TTL)
      // Actual persistence happens in the route handler
      req.watchProgressMeta = {
        idempotencyKey,
        clientTimestamp: clientTimestamp || Date.now()
      };

      next();
    } catch (error) {
      logger.error({
        error: error.message,
        contentId,
        profileId
      }, 'Watch progress idempotency check failed');
      next();
    }
  };
}

/**
 * Helper to complete watch progress idempotency after successful update
 *
 * @param {Object} redis - Redis client
 * @param {Object} meta - Idempotency metadata from request
 */
async function completeWatchProgressIdempotency(redis, meta) {
  if (!meta?.idempotencyKey) return;

  await redis.setEx(meta.idempotencyKey, 60, JSON.stringify({
    clientTimestamp: meta.clientTimestamp,
    updatedAt: Date.now()
  }));
}

module.exports = {
  idempotencyMiddleware,
  createIdempotencyKey,
  checkIdempotency,
  markIdempotent,
  watchProgressIdempotency,
  completeWatchProgressIdempotency,
  IDEMPOTENCY_TTL,
  LOCK_TTL
};
