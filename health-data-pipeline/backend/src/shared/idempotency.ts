import { redis } from '../config/redis.js';
import { logger } from './logger.js';
import { cacheTTLConfig } from './retention.js';
import { idempotencyOperations } from './metrics.js';

/**
 * Idempotency for health data ingestion.
 *
 * WHY: Idempotency is critical for health data pipelines because:
 * - Mobile devices often retry failed requests (network issues)
 * - Users may accidentally trigger multiple syncs
 * - Duplicate data corrupts aggregations and insights
 * - HIPAA requires accurate data records
 *
 * Implementation:
 * - Client sends an idempotency key (usually hash of samples + timestamp)
 * - Server checks if key was seen before
 * - If seen: return cached response (no re-processing)
 * - If new: process request, cache response with TTL
 *
 * This is superior to just ON CONFLICT DO NOTHING because:
 * - Prevents wasted processing (validation, aggregation)
 * - Reduces database load
 * - Provides consistent responses to retries
 */

const IDEMPOTENCY_PREFIX = cacheTTLConfig.idempotency.prefix;
const IDEMPOTENCY_TTL = cacheTTLConfig.idempotency.ttlSeconds;

/**
 * Check if a request is a duplicate based on idempotency key.
 *
 * @param {string} idempotencyKey - Unique key for this request
 * @returns {Promise<{isDuplicate: boolean, cachedResponse: any}>}
 */
export async function checkIdempotency(idempotencyKey) {
  if (!idempotencyKey) {
    return { isDuplicate: false, cachedResponse: null };
  }

  const cacheKey = `${IDEMPOTENCY_PREFIX}${idempotencyKey}`;

  try {
    const cached = await redis.get(cacheKey);

    if (cached) {
      idempotencyOperations.inc({ result: 'duplicate' });
      logger.info({
        msg: 'Duplicate request detected',
        idempotencyKey
      });
      return { isDuplicate: true, cachedResponse: JSON.parse(cached) };
    }

    return { isDuplicate: false, cachedResponse: null };
  } catch (error) {
    // On cache error, proceed with request (fail open)
    logger.warn({
      msg: 'Idempotency check failed, proceeding',
      error: error.message,
      idempotencyKey
    });
    return { isDuplicate: false, cachedResponse: null };
  }
}

/**
 * Store idempotency key and response.
 *
 * @param {string} idempotencyKey - Unique key for this request
 * @param {object} response - Response to cache
 */
export async function storeIdempotencyKey(idempotencyKey, response) {
  if (!idempotencyKey) {
    return;
  }

  const cacheKey = `${IDEMPOTENCY_PREFIX}${idempotencyKey}`;

  try {
    await redis.setex(cacheKey, IDEMPOTENCY_TTL, JSON.stringify(response));
    idempotencyOperations.inc({ result: 'new' });

    logger.debug({
      msg: 'Stored idempotency key',
      idempotencyKey,
      ttl: IDEMPOTENCY_TTL
    });
  } catch (error) {
    // Log but don't fail the request
    logger.warn({
      msg: 'Failed to store idempotency key',
      error: error.message,
      idempotencyKey
    });
  }
}

/**
 * Generate an idempotency key from request data.
 * Combines user ID, device ID, and content hash.
 *
 * @param {string} userId
 * @param {string} deviceId
 * @param {Array} samples - Array of health samples
 * @returns {string} Idempotency key
 */
export function generateIdempotencyKey(userId, deviceId, samples) {
  // Create a deterministic hash of the samples
  const sampleSignature = samples.map(s => ({
    type: s.type,
    value: s.value,
    startDate: s.startDate,
    endDate: s.endDate
  }));

  // Simple hash function (for production, use crypto.createHash)
  const contentHash = simpleHash(JSON.stringify(sampleSignature));

  return `${userId}:${deviceId}:${contentHash}`;
}

/**
 * Simple hash function for idempotency keys.
 * For production, consider using crypto.createHash('sha256').
 */
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Express middleware for idempotent POST requests.
 * Checks X-Idempotency-Key header.
 */
export function idempotencyMiddleware(req, res, next) {
  const idempotencyKey = req.headers['x-idempotency-key'];

  if (!idempotencyKey) {
    // No idempotency key provided, proceed normally
    return next();
  }

  // Check for duplicate
  checkIdempotency(idempotencyKey)
    .then(({ isDuplicate, cachedResponse }) => {
      if (isDuplicate) {
        // Return cached response
        return res.json(cachedResponse);
      }

      // Store original res.json to intercept response
      const originalJson = res.json.bind(res);
      res.json = (data) => {
        // Store the response for future duplicates
        storeIdempotencyKey(idempotencyKey, data)
          .catch(err => logger.error({ msg: 'Failed to cache response', error: err.message }));

        return originalJson(data);
      };

      next();
    })
    .catch(error => {
      logger.error({ msg: 'Idempotency middleware error', error: error.message });
      next();
    });
}

/**
 * Clean up expired idempotency keys.
 * Not strictly necessary (Redis handles TTL), but useful for monitoring.
 */
export async function cleanupExpiredKeys() {
  // Redis handles TTL automatically, but we can scan for stats
  const keys = await redis.keys(`${IDEMPOTENCY_PREFIX}*`);
  logger.info({
    msg: 'Active idempotency keys',
    count: keys.length
  });
  return keys.length;
}

export default {
  checkIdempotency,
  storeIdempotencyKey,
  generateIdempotencyKey,
  idempotencyMiddleware,
  cleanupExpiredKeys
};
