import { query } from './db.js';
import logger from './logger.js';
import { idempotencyHits, idempotencyMisses } from './metrics.js';

/**
 * Idempotency service for preventing duplicate operations
 * Uses PostgreSQL for durable storage of idempotency keys
 *
 * WHY IDEMPOTENCY MATTERS:
 * 1. Prevents inventory overselling when checkout is retried
 * 2. Ensures exactly-once semantics for order creation
 * 3. Handles network failures and client retries safely
 * 4. Critical for financial operations that cannot be duplicated
 */

// Status values for idempotency records
export const IdempotencyStatus = {
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

/**
 * Check if an idempotency key already exists and return its status
 * @param {string} key - Idempotency key
 * @param {number} storeId - Store ID (for tenant isolation)
 * @param {string} operation - Operation type (checkout, inventory_update, etc.)
 * @returns {object|null} Existing record or null
 */
export async function checkIdempotencyKey(key, storeId, operation) {
  try {
    const result = await query(
      `SELECT * FROM idempotency_keys
       WHERE idempotency_key = $1 AND store_id = $2 AND operation = $3`,
      [key, storeId, operation]
    );

    if (result.rows.length > 0) {
      idempotencyHits.inc({ operation });
      logger.debug({ key, storeId, operation }, 'Idempotency key hit');
      return result.rows[0];
    }

    idempotencyMisses.inc({ operation });
    return null;
  } catch (error) {
    logger.error({ err: error, key, storeId }, 'Failed to check idempotency key');
    throw error;
  }
}

/**
 * Create or update an idempotency record
 * @param {string} key - Idempotency key
 * @param {number} storeId - Store ID
 * @param {string} operation - Operation type
 * @param {string} status - Processing status
 * @param {object} metadata - Additional metadata (request params, etc.)
 * @returns {object} Created/updated record
 */
export async function createIdempotencyKey(key, storeId, operation, status = IdempotencyStatus.PROCESSING, metadata = {}) {
  try {
    const result = await query(
      `INSERT INTO idempotency_keys (idempotency_key, store_id, operation, status, request_params, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (idempotency_key, store_id, operation)
       DO UPDATE SET status = $4, updated_at = NOW()
       RETURNING *`,
      [key, storeId, operation, status, JSON.stringify(metadata)]
    );

    logger.debug({ key, storeId, operation, status }, 'Idempotency key created/updated');
    return result.rows[0];
  } catch (error) {
    logger.error({ err: error, key, storeId }, 'Failed to create idempotency key');
    throw error;
  }
}

/**
 * Mark idempotency key as completed with result
 * @param {string} key - Idempotency key
 * @param {number} storeId - Store ID
 * @param {string} operation - Operation type
 * @param {object} result - Operation result to cache
 * @param {number} resourceId - ID of created resource (order_id, etc.)
 */
export async function completeIdempotencyKey(key, storeId, operation, result, resourceId = null) {
  try {
    await query(
      `UPDATE idempotency_keys
       SET status = $1, response_data = $2, resource_id = $3, updated_at = NOW()
       WHERE idempotency_key = $4 AND store_id = $5 AND operation = $6`,
      [IdempotencyStatus.COMPLETED, JSON.stringify(result), resourceId, key, storeId, operation]
    );

    logger.debug({ key, storeId, operation, resourceId }, 'Idempotency key completed');
  } catch (error) {
    logger.error({ err: error, key, storeId }, 'Failed to complete idempotency key');
    throw error;
  }
}

/**
 * Mark idempotency key as failed with error
 * @param {string} key - Idempotency key
 * @param {number} storeId - Store ID
 * @param {string} operation - Operation type
 * @param {Error} error - Error that occurred
 */
export async function failIdempotencyKey(key, storeId, operation, error) {
  try {
    await query(
      `UPDATE idempotency_keys
       SET status = $1, error_message = $2, updated_at = NOW()
       WHERE idempotency_key = $3 AND store_id = $4 AND operation = $5`,
      [IdempotencyStatus.FAILED, error.message, key, storeId, operation]
    );

    logger.debug({ key, storeId, operation, error: error.message }, 'Idempotency key marked as failed');
  } catch (err) {
    logger.error({ err, key, storeId }, 'Failed to mark idempotency key as failed');
    throw err;
  }
}

/**
 * Clean up old idempotency keys (called periodically)
 * Keys older than 24 hours are removed
 */
export async function cleanupIdempotencyKeys() {
  try {
    const result = await query(
      `DELETE FROM idempotency_keys WHERE created_at < NOW() - INTERVAL '24 hours'`
    );

    if (result.rowCount > 0) {
      logger.info({ deleted: result.rowCount }, 'Cleaned up old idempotency keys');
    }
  } catch (error) {
    logger.error({ err: error }, 'Failed to cleanup idempotency keys');
  }
}

/**
 * Idempotent operation wrapper
 * Wraps an async operation with idempotency checking
 *
 * @param {string} key - Idempotency key
 * @param {number} storeId - Store ID
 * @param {string} operation - Operation name
 * @param {function} fn - Async function to execute
 * @param {object} metadata - Request metadata to store
 * @returns {object} { result, deduplicated }
 */
export async function withIdempotency(key, storeId, operation, fn, metadata = {}) {
  // Check for existing key
  const existing = await checkIdempotencyKey(key, storeId, operation);

  if (existing) {
    switch (existing.status) {
      case IdempotencyStatus.COMPLETED:
        // Return cached result
        return {
          result: existing.response_data,
          resourceId: existing.resource_id,
          deduplicated: true,
        };

      case IdempotencyStatus.PROCESSING:
        // Request is in progress - reject to prevent race condition
        throw new Error('Request already in progress. Please wait and retry.');

      case IdempotencyStatus.FAILED:
        // Previous attempt failed - allow retry by continuing
        logger.info({ key, storeId, operation }, 'Retrying previously failed idempotent operation');
        break;
    }
  }

  // Create idempotency record
  await createIdempotencyKey(key, storeId, operation, IdempotencyStatus.PROCESSING, metadata);

  try {
    // Execute the operation
    const result = await fn();

    // Mark as completed
    await completeIdempotencyKey(key, storeId, operation, result, result?.id || result?.orderId);

    return {
      result,
      deduplicated: false,
    };
  } catch (error) {
    // Mark as failed
    await failIdempotencyKey(key, storeId, operation, error);
    throw error;
  }
}

/**
 * Middleware to extract and validate idempotency key from request
 */
export function idempotencyMiddleware(req, res, next) {
  const idempotencyKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];

  if (idempotencyKey) {
    // Validate key format (should be UUID or similar)
    if (idempotencyKey.length < 16 || idempotencyKey.length > 64) {
      return res.status(400).json({
        error: 'Invalid idempotency key. Must be 16-64 characters.',
      });
    }

    req.idempotencyKey = idempotencyKey;
  }

  next();
}

// Start cleanup job (every hour)
setInterval(cleanupIdempotencyKeys, 60 * 60 * 1000);

export default {
  IdempotencyStatus,
  checkIdempotencyKey,
  createIdempotencyKey,
  completeIdempotencyKey,
  failIdempotencyKey,
  cleanupIdempotencyKeys,
  withIdempotency,
  idempotencyMiddleware,
};
