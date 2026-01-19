/**
 * Idempotency middleware for sync operations
 *
 * WHY: Network failures and client retries can cause duplicate requests. Without
 * idempotency, retrying a file upload or sync operation could result in duplicate
 * data or conflicts. Idempotency keys ensure that repeated requests with the same
 * key return the same result without re-executing the operation.
 *
 * This is critical for sync operations where clients may retry on timeout but
 * the server actually processed the request successfully.
 */

import crypto from 'crypto';
import { TTL } from './cache.js';
import logger from './logger.js';

const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
const LOCK_PREFIX = 'idempotency:lock:';
const RESULT_PREFIX = 'idempotency:result:';

/**
 * Idempotency middleware factory
 */
export function createIdempotencyMiddleware(redis) {
  return function idempotencyMiddleware(req, res, next) {
    const idempotencyKey = req.headers[IDEMPOTENCY_KEY_HEADER];

    // If no idempotency key provided, proceed normally
    if (!idempotencyKey) {
      return next();
    }

    // Validate key format (should be a reasonable length string)
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length > 256) {
      return res.status(400).json({
        error: 'Invalid idempotency key format',
      });
    }

    // Attach idempotency handler to request
    req.idempotency = new IdempotencyHandler(redis, idempotencyKey, req, res);
    next();
  };
}

/**
 * Idempotency handler for individual requests
 */
export class IdempotencyHandler {
  constructor(redis, key, req, res) {
    this.redis = redis;
    this.key = key;
    this.req = req;
    this.res = res;
    this.lockKey = `${LOCK_PREFIX}${key}`;
    this.resultKey = `${RESULT_PREFIX}${key}`;
  }

  /**
   * Check if this request was already processed
   * Returns { processed: true, result: {...} } if already done
   * Returns { processed: false } if new request
   */
  async checkAndLock() {
    // Check if result already exists
    const existingResult = await this.redis.get(this.resultKey);
    if (existingResult) {
      logger.info(
        { idempotencyKey: this.key },
        'Returning cached idempotent result'
      );
      return {
        processed: true,
        result: JSON.parse(existingResult),
      };
    }

    // Try to acquire lock
    const lockAcquired = await this.redis.set(
      this.lockKey,
      JSON.stringify({
        requestId: crypto.randomUUID(),
        startedAt: new Date().toISOString(),
      }),
      'NX', // Only set if not exists
      'EX',
      300 // 5 minute lock timeout
    );

    if (!lockAcquired) {
      // Another request is processing this - wait for result
      logger.info(
        { idempotencyKey: this.key },
        'Waiting for in-progress idempotent request'
      );

      const result = await this._waitForResult();
      if (result) {
        return { processed: true, result };
      }

      // Timeout waiting - return conflict
      return {
        processed: false,
        conflict: true,
        error: 'Request with same idempotency key is in progress',
      };
    }

    return { processed: false };
  }

  /**
   * Save the result for future duplicate requests
   */
  async saveResult(result, statusCode = 200) {
    const resultData = {
      statusCode,
      body: result,
      processedAt: new Date().toISOString(),
    };

    try {
      await this.redis.setex(
        this.resultKey,
        TTL.IDEMPOTENCY,
        JSON.stringify(resultData)
      );
    } finally {
      // Always release the lock
      await this.redis.del(this.lockKey);
    }

    return resultData;
  }

  /**
   * Release lock on error without saving result
   * This allows the request to be retried
   */
  async releaseLock() {
    await this.redis.del(this.lockKey);
  }

  /**
   * Wait for another request to complete and return its result
   */
  async _waitForResult(maxWaitMs = 30000, pollIntervalMs = 100) {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const result = await this.redis.get(this.resultKey);
      if (result) {
        return JSON.parse(result);
      }

      // Check if lock still exists
      const lockExists = await this.redis.exists(this.lockKey);
      if (!lockExists) {
        // Lock released but no result - original request failed
        return null;
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    return null;
  }
}

/**
 * Express middleware that wraps sync operations with idempotency
 * Use this decorator for routes that need idempotency protection
 */
export function withIdempotency(handler) {
  return async (req, res, next) => {
    // If no idempotency handler attached, run normally
    if (!req.idempotency) {
      return handler(req, res, next);
    }

    try {
      // Check for existing result
      const check = await req.idempotency.checkAndLock();

      if (check.processed) {
        // Return cached result
        return res
          .status(check.result.statusCode)
          .json(check.result.body);
      }

      if (check.conflict) {
        return res.status(409).json({
          error: check.error,
          retryAfter: 5,
        });
      }

      // Override res.json to capture the result
      const originalJson = res.json.bind(res);
      res.json = async function (data) {
        try {
          await req.idempotency.saveResult(data, res.statusCode);
        } catch (saveError) {
          logger.error(
            { error: saveError.message },
            'Failed to save idempotent result'
          );
        }
        return originalJson(data);
      };

      // Run the actual handler
      await handler(req, res, next);
    } catch (error) {
      // Release lock on error so request can be retried
      await req.idempotency.releaseLock();
      next(error);
    }
  };
}

/**
 * Generate an idempotency key from request data
 * Useful for clients to generate deterministic keys
 */
export function generateIdempotencyKey(userId, operation, data) {
  const payload = JSON.stringify({
    userId,
    operation,
    data,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

export default {
  createIdempotencyMiddleware,
  IdempotencyHandler,
  withIdempotency,
  generateIdempotencyKey,
  IDEMPOTENCY_KEY_HEADER,
};
