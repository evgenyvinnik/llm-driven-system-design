import redis from '../redis.js';
import logger from './logger.js';
import { idempotencyHits, idempotencyMisses } from './metrics.js';

/**
 * Idempotency Module
 *
 * WHY: Idempotency ensures that:
 * - Retry-safe operations: Network failures can be safely retried
 * - Exactly-once semantics: Prevents duplicate processing
 * - Consistent results: Same request always returns same response
 * - Client simplicity: Clients don't need complex retry logic
 *
 * Implementation:
 * - Uses Redis for distributed idempotency key storage
 * - TTL-based expiration for automatic cleanup
 * - Stores both status and result for replay
 */

const DEFAULT_TTL_SECONDS = 86400; // 24 hours
const PROCESSING_TIMEOUT_SECONDS = 60; // Lock timeout for in-progress requests

/**
 * Idempotency states
 */
const IdempotencyState = {
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

/**
 * Generate a cache key for idempotency
 */
function getIdempotencyKey(operation, idempotencyKey) {
  return `idempotency:${operation}:${idempotencyKey}`;
}

/**
 * Check if a request is a replay and return cached result
 * @param {string} operation - The operation type (e.g., 'location_update', 'incident_report')
 * @param {string} idempotencyKey - Client-provided idempotency key
 * @returns {Object|null} - Cached result if replay, null if new request
 */
async function checkIdempotency(operation, idempotencyKey) {
  if (!idempotencyKey) {
    return null; // No idempotency key provided
  }

  const key = getIdempotencyKey(operation, idempotencyKey);

  try {
    const cached = await redis.get(key);

    if (cached) {
      const data = JSON.parse(cached);

      if (data.state === IdempotencyState.PROCESSING) {
        // Request still processing - could be concurrent duplicate or previous failure
        const elapsedMs = Date.now() - data.startedAt;
        if (elapsedMs < PROCESSING_TIMEOUT_SECONDS * 1000) {
          // Still within timeout - tell client to retry later
          idempotencyHits.inc({ operation });
          logger.debug({ operation, idempotencyKey }, 'Idempotency: request still processing');
          return {
            isProcessing: true,
            retryAfter: Math.ceil((PROCESSING_TIMEOUT_SECONDS * 1000 - elapsedMs) / 1000),
          };
        }
        // Timeout expired - treat as new request
        logger.warn(
          { operation, idempotencyKey },
          'Idempotency: previous processing timed out, allowing retry'
        );
        return null;
      }

      if (data.state === IdempotencyState.COMPLETED) {
        idempotencyHits.inc({ operation });
        logger.debug({ operation, idempotencyKey }, 'Idempotency: returning cached result');
        return {
          isReplay: true,
          result: data.result,
          statusCode: data.statusCode,
        };
      }

      if (data.state === IdempotencyState.FAILED) {
        // Previous request failed - allow retry
        logger.debug({ operation, idempotencyKey }, 'Idempotency: previous attempt failed, allowing retry');
        return null;
      }
    }

    return null; // Not found = new request
  } catch (error) {
    logger.error({ error, operation, idempotencyKey }, 'Idempotency check failed');
    return null; // Fail open - allow the request
  }
}

/**
 * Start processing a new idempotent request
 * @param {string} operation - The operation type
 * @param {string} idempotencyKey - Client-provided idempotency key
 * @param {number} ttl - TTL in seconds
 * @returns {boolean} - True if lock acquired, false if already processing
 */
async function startIdempotentRequest(operation, idempotencyKey, ttl = DEFAULT_TTL_SECONDS) {
  if (!idempotencyKey) {
    return true; // No idempotency key - proceed normally
  }

  const key = getIdempotencyKey(operation, idempotencyKey);

  try {
    // Use SET NX (only if not exists) to acquire lock
    const result = await redis.set(
      key,
      JSON.stringify({
        state: IdempotencyState.PROCESSING,
        startedAt: Date.now(),
      }),
      'EX',
      ttl,
      'NX'
    );

    if (result === 'OK') {
      idempotencyMisses.inc({ operation });
      logger.debug({ operation, idempotencyKey }, 'Idempotency: started new request');
      return true;
    }

    // Key already exists
    logger.debug({ operation, idempotencyKey }, 'Idempotency: key already exists');
    return false;
  } catch (error) {
    logger.error({ error, operation, idempotencyKey }, 'Idempotency start failed');
    return true; // Fail open
  }
}

/**
 * Complete an idempotent request with success
 * @param {string} operation - The operation type
 * @param {string} idempotencyKey - Client-provided idempotency key
 * @param {Object} result - The result to cache
 * @param {number} statusCode - HTTP status code
 * @param {number} ttl - TTL in seconds
 */
async function completeIdempotentRequest(
  operation,
  idempotencyKey,
  result,
  statusCode = 200,
  ttl = DEFAULT_TTL_SECONDS
) {
  if (!idempotencyKey) {
    return;
  }

  const key = getIdempotencyKey(operation, idempotencyKey);

  try {
    await redis.setex(
      key,
      ttl,
      JSON.stringify({
        state: IdempotencyState.COMPLETED,
        result,
        statusCode,
        completedAt: Date.now(),
      })
    );
    logger.debug({ operation, idempotencyKey }, 'Idempotency: completed successfully');
  } catch (error) {
    logger.error({ error, operation, idempotencyKey }, 'Idempotency completion failed');
  }
}

/**
 * Mark an idempotent request as failed
 * @param {string} operation - The operation type
 * @param {string} idempotencyKey - Client-provided idempotency key
 * @param {string} errorMessage - The error message
 */
async function failIdempotentRequest(operation, idempotencyKey, errorMessage) {
  if (!idempotencyKey) {
    return;
  }

  const key = getIdempotencyKey(operation, idempotencyKey);

  try {
    // Set with short TTL to allow retries
    await redis.setex(
      key,
      PROCESSING_TIMEOUT_SECONDS,
      JSON.stringify({
        state: IdempotencyState.FAILED,
        error: errorMessage,
        failedAt: Date.now(),
      })
    );
    logger.debug({ operation, idempotencyKey }, 'Idempotency: marked as failed');
  } catch (error) {
    logger.error({ error, operation, idempotencyKey }, 'Idempotency failure marking failed');
  }
}

/**
 * Express middleware for idempotent endpoints
 * @param {string} operation - The operation name
 */
function idempotencyMiddleware(operation) {
  return async (req, res, next) => {
    const idempotencyKey =
      req.headers['idempotency-key'] || req.headers['x-idempotency-key'];

    if (!idempotencyKey) {
      // No idempotency key provided - proceed without protection
      return next();
    }

    // Check for existing result
    const existing = await checkIdempotency(operation, idempotencyKey);

    if (existing?.isProcessing) {
      return res.status(409).json({
        error: 'Request still processing',
        retryAfter: existing.retryAfter,
      });
    }

    if (existing?.isReplay) {
      return res.status(existing.statusCode).json(existing.result);
    }

    // Try to acquire lock
    const acquired = await startIdempotentRequest(operation, idempotencyKey);
    if (!acquired) {
      // Race condition - another request got the lock
      return res.status(409).json({
        error: 'Duplicate request in progress',
        retryAfter: 5,
      });
    }

    // Store idempotency info on request for later completion
    req.idempotency = {
      operation,
      key: idempotencyKey,
    };

    // Override res.json to capture the response
    const originalJson = res.json.bind(res);
    res.json = async function (data) {
      if (req.idempotency && res.statusCode < 500) {
        await completeIdempotentRequest(
          req.idempotency.operation,
          req.idempotency.key,
          data,
          res.statusCode
        );
      } else if (req.idempotency) {
        await failIdempotentRequest(
          req.idempotency.operation,
          req.idempotency.key,
          data?.error || 'Unknown error'
        );
      }
      return originalJson(data);
    };

    next();
  };
}

export {
  checkIdempotency,
  startIdempotentRequest,
  completeIdempotentRequest,
  failIdempotentRequest,
  idempotencyMiddleware,
  IdempotencyState,
};
