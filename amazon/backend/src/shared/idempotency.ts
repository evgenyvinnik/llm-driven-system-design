/**
 * Idempotency Key Handling for Order Placement
 *
 * Prevents duplicate orders from:
 * - Network retries
 * - User double-clicking checkout
 * - Client-side retry logic
 *
 * Uses Redis for fast lookups with TTL, with PostgreSQL fallback for durability.
 */
import crypto from 'crypto';
import { getRedis } from '../services/redis.js';
import { query } from '../services/database.js';
import logger, { LogEvents } from './logger.js';
import { idempotencyHitsTotal } from './metrics.js';

// Idempotency key TTL (24 hours by default)
const IDEMPOTENCY_TTL_SECONDS = parseInt(process.env.IDEMPOTENCY_TTL_SECONDS) || 86400;

// Redis key prefix
const REDIS_PREFIX = 'idempotency:';

/**
 * Idempotency record structure
 * @typedef {Object} IdempotencyRecord
 * @property {string} key - The idempotency key
 * @property {string} status - 'processing' | 'completed' | 'failed'
 * @property {Object} response - Cached response for completed requests
 * @property {number} createdAt - Timestamp when record was created
 * @property {number} completedAt - Timestamp when request completed
 */

/**
 * Generate an idempotency key for a request
 * Client should generate this, but we provide a fallback
 * @param {Object} req - Express request object
 * @returns {string} Idempotency key
 */
export function generateIdempotencyKey(req) {
  // Client-provided key takes precedence
  if (req.headers['idempotency-key']) {
    return req.headers['idempotency-key'];
  }

  if (req.headers['x-idempotency-key']) {
    return req.headers['x-idempotency-key'];
  }

  // Fallback: Generate from user ID + timestamp + random
  // This is less ideal as it doesn't prevent double-clicks
  const userId = req.user?.id || 'anonymous';
  return `${userId}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Check if an idempotency key exists and return cached response if available
 * @param {string} key - Idempotency key
 * @returns {Promise<IdempotencyRecord|null>} Cached record or null
 */
export async function getIdempotencyRecord(key) {
  try {
    const redis = getRedis();
    const redisKey = `${REDIS_PREFIX}${key}`;

    // Try Redis first (fast)
    const cached = await redis.get(redisKey);
    if (cached) {
      const record = JSON.parse(cached);
      logger.debug({ key, status: record.status }, 'Idempotency key found in Redis');
      return record;
    }

    // Fallback to PostgreSQL for durability
    const result = await query(
      'SELECT * FROM idempotency_keys WHERE key = $1',
      [key]
    );

    if (result.rows.length > 0) {
      const dbRecord = result.rows[0];
      const record = {
        key: dbRecord.key,
        status: dbRecord.status,
        response: dbRecord.response,
        createdAt: dbRecord.created_at,
        completedAt: dbRecord.completed_at
      };

      // Cache in Redis for faster subsequent lookups
      await redis.set(redisKey, JSON.stringify(record), { EX: IDEMPOTENCY_TTL_SECONDS });

      logger.debug({ key, status: record.status }, 'Idempotency key found in PostgreSQL');
      return record;
    }

    return null;
  } catch (error) {
    logger.error({ key, error: error.message }, 'Error checking idempotency key');
    // On error, return null to allow the request to proceed
    // This is a trade-off: better to risk duplicate than block all requests
    return null;
  }
}

/**
 * Create a new idempotency record in 'processing' state
 * Uses Redis SETNX for atomic check-and-set
 * @param {string} key - Idempotency key
 * @param {Object} requestData - Original request data for debugging
 * @returns {Promise<boolean>} True if record was created, false if key already exists
 */
export async function createIdempotencyRecord(key, requestData = {}) {
  try {
    const redis = getRedis();
    const redisKey = `${REDIS_PREFIX}${key}`;

    const record = {
      key,
      status: 'processing',
      response: null,
      requestData,
      createdAt: Date.now(),
      completedAt: null
    };

    // Atomic set-if-not-exists in Redis
    const result = await redis.set(redisKey, JSON.stringify(record), {
      NX: true, // Only set if not exists
      EX: IDEMPOTENCY_TTL_SECONDS
    });

    if (result === null) {
      // Key already exists
      logger.info({ key }, 'Idempotency key already exists (duplicate request)');
      return false;
    }

    // Also store in PostgreSQL for durability
    try {
      await query(
        `INSERT INTO idempotency_keys (key, status, request_data, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (key) DO NOTHING`,
        [key, 'processing', JSON.stringify(requestData)]
      );
    } catch (dbError) {
      // PostgreSQL insert failed, but Redis succeeded
      // Log warning but continue - Redis is primary
      logger.warn({ key, error: dbError.message }, 'Failed to store idempotency key in PostgreSQL');
    }

    logger.debug({ key }, 'Created idempotency record');
    return true;
  } catch (error) {
    logger.error({ key, error: error.message }, 'Error creating idempotency record');
    // On error, return true to allow request to proceed
    return true;
  }
}

/**
 * Complete an idempotency record with response
 * @param {string} key - Idempotency key
 * @param {string} status - 'completed' | 'failed'
 * @param {Object} response - Response to cache
 * @returns {Promise<void>}
 */
export async function completeIdempotencyRecord(key, status, response) {
  try {
    const redis = getRedis();
    const redisKey = `${REDIS_PREFIX}${key}`;

    const record = {
      key,
      status,
      response,
      createdAt: Date.now(), // Will be overwritten if exists
      completedAt: Date.now()
    };

    // Update Redis
    await redis.set(redisKey, JSON.stringify(record), { EX: IDEMPOTENCY_TTL_SECONDS });

    // Update PostgreSQL
    await query(
      `UPDATE idempotency_keys
       SET status = $1, response = $2, completed_at = NOW()
       WHERE key = $3`,
      [status, JSON.stringify(response), key]
    );

    logger.debug({ key, status }, 'Completed idempotency record');
  } catch (error) {
    logger.error({ key, error: error.message }, 'Error completing idempotency record');
  }
}

/**
 * Middleware for idempotency handling
 * Attaches idempotency functions to request object
 */
export function idempotencyMiddleware(req, res, next) {
  // Only apply to POST/PUT/PATCH requests
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) {
    return next();
  }

  // Extract idempotency key from headers
  const idempotencyKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];

  if (idempotencyKey) {
    req.idempotencyKey = idempotencyKey;
  }

  next();
}

/**
 * Handle idempotent order placement
 * Returns cached response if duplicate, otherwise allows request
 * @param {Object} req - Express request object
 * @returns {Promise<{isDuplicate: boolean, response?: Object}>}
 */
export async function handleIdempotentOrder(req) {
  const key = req.idempotencyKey || generateIdempotencyKey(req);

  // Check for existing record
  const existingRecord = await getIdempotencyRecord(key);

  if (existingRecord) {
    // Record exists
    if (existingRecord.status === 'processing') {
      // Request is still being processed - likely a race condition
      logger.warn({ key }, 'Idempotent request still processing');
      return {
        isDuplicate: true,
        isProcessing: true,
        response: { error: 'Request is still being processed', retryAfter: 5 }
      };
    }

    if (existingRecord.status === 'completed') {
      // Return cached successful response
      logger.info({ key, event: LogEvents.IDEMPOTENCY_HIT }, 'Returning cached order response');
      idempotencyHitsTotal.inc();
      return {
        isDuplicate: true,
        isProcessing: false,
        response: existingRecord.response
      };
    }

    if (existingRecord.status === 'failed') {
      // Previous request failed - allow retry with same key
      logger.info({ key }, 'Previous request failed, allowing retry');
      // Update record to processing
      await createIdempotencyRecord(key, { body: req.body, userId: req.user?.id });
      return { isDuplicate: false };
    }
  }

  // No existing record - create new one
  const created = await createIdempotencyRecord(key, {
    body: req.body,
    userId: req.user?.id
  });

  if (!created) {
    // Race condition - another request created the record
    const record = await getIdempotencyRecord(key);
    if (record?.status === 'completed') {
      idempotencyHitsTotal.inc();
      return {
        isDuplicate: true,
        isProcessing: false,
        response: record.response
      };
    }
    return {
      isDuplicate: true,
      isProcessing: true,
      response: { error: 'Request is being processed', retryAfter: 5 }
    };
  }

  // Store key in request for later completion
  req.idempotencyKey = key;
  return { isDuplicate: false };
}

/**
 * Complete order with idempotency record update
 * @param {Object} req - Express request object
 * @param {Object} order - Created order
 * @returns {Promise<void>}
 */
export async function completeIdempotentOrder(req, order) {
  if (req.idempotencyKey) {
    await completeIdempotencyRecord(req.idempotencyKey, 'completed', { order });
  }
}

/**
 * Mark order creation as failed
 * @param {Object} req - Express request object
 * @param {Object} error - Error that occurred
 * @returns {Promise<void>}
 */
export async function failIdempotentOrder(req, error) {
  if (req.idempotencyKey) {
    await completeIdempotencyRecord(req.idempotencyKey, 'failed', {
      error: error.message,
      code: error.code
    });
  }
}

/**
 * Cleanup expired idempotency keys from PostgreSQL
 * Run as a scheduled job
 */
export async function cleanupExpiredIdempotencyKeys() {
  try {
    const cutoffDate = new Date(Date.now() - IDEMPOTENCY_TTL_SECONDS * 1000);

    const result = await query(
      'DELETE FROM idempotency_keys WHERE created_at < $1',
      [cutoffDate]
    );

    logger.info({ deleted: result.rowCount }, 'Cleaned up expired idempotency keys');
    return result.rowCount;
  } catch (error) {
    logger.error({ error: error.message }, 'Error cleaning up idempotency keys');
    throw error;
  }
}

export default {
  generateIdempotencyKey,
  getIdempotencyRecord,
  createIdempotencyRecord,
  completeIdempotencyRecord,
  idempotencyMiddleware,
  handleIdempotentOrder,
  completeIdempotentOrder,
  failIdempotentOrder,
  cleanupExpiredIdempotencyKeys
};
