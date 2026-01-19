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
import type { Redis } from 'ioredis';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { TTL } from './cache.js';
import logger from './logger.js';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
const LOCK_PREFIX = 'idempotency:lock:';
const RESULT_PREFIX = 'idempotency:result:';

export interface IdempotencyResult {
  statusCode: number;
  body: unknown;
  processedAt: string;
}

export interface CheckResult {
  processed: boolean;
  result?: IdempotencyResult;
  conflict?: boolean;
  error?: string;
}

// Extend Express Request to include idempotency handler
declare global {
  namespace Express {
    interface Request {
      idempotency?: IdempotencyHandler;
    }
  }
}

/**
 * Idempotency middleware factory
 */
export function createIdempotencyMiddleware(redis: Redis): RequestHandler {
  return function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): void {
    const idempotencyKey = req.headers[IDEMPOTENCY_KEY_HEADER] as string | undefined;

    // If no idempotency key provided, proceed normally
    if (!idempotencyKey) {
      next();
      return;
    }

    // Validate key format (should be a reasonable length string)
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length > 256) {
      res.status(400).json({
        error: 'Invalid idempotency key format',
      });
      return;
    }

    // Attach idempotency handler to request
    req.idempotency = new IdempotencyHandler(redis, idempotencyKey);
    next();
  };
}

/**
 * Idempotency handler for individual requests
 */
export class IdempotencyHandler {
  private redis: Redis;
  private key: string;
  private lockKey: string;
  private resultKey: string;

  constructor(redis: Redis, key: string) {
    this.redis = redis;
    this.key = key;
    this.lockKey = `${LOCK_PREFIX}${key}`;
    this.resultKey = `${RESULT_PREFIX}${key}`;
  }

  /**
   * Check if this request was already processed
   * Returns { processed: true, result: {...} } if already done
   * Returns { processed: false } if new request
   */
  async checkAndLock(): Promise<CheckResult> {
    // Check if result already exists
    const existingResult = await this.redis.get(this.resultKey);
    if (existingResult) {
      logger.info(
        { idempotencyKey: this.key },
        'Returning cached idempotent result'
      );
      return {
        processed: true,
        result: JSON.parse(existingResult) as IdempotencyResult,
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
  async saveResult(result: unknown, statusCode: number = 200): Promise<IdempotencyResult> {
    const resultData: IdempotencyResult = {
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
  async releaseLock(): Promise<void> {
    await this.redis.del(this.lockKey);
  }

  /**
   * Wait for another request to complete and return its result
   */
  private async _waitForResult(maxWaitMs: number = 30000, pollIntervalMs: number = 100): Promise<IdempotencyResult | null> {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const result = await this.redis.get(this.resultKey);
      if (result) {
        return JSON.parse(result) as IdempotencyResult;
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
export function withIdempotency(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // If no idempotency handler attached, run normally
    if (!req.idempotency) {
      await handler(req, res, next);
      return;
    }

    try {
      // Check for existing result
      const check = await req.idempotency.checkAndLock();

      if (check.processed && check.result) {
        // Return cached result
        res.status(check.result.statusCode).json(check.result.body);
        return;
      }

      if (check.conflict) {
        res.status(409).json({
          error: check.error,
          retryAfter: 5,
        });
        return;
      }

      // Override res.json to capture the result
      const originalJson = res.json.bind(res);
      res.json = function (data: unknown) {
        (async () => {
          try {
            await req.idempotency?.saveResult(data, res.statusCode);
          } catch (saveError) {
            logger.error(
              { error: (saveError as Error).message },
              'Failed to save idempotent result'
            );
          }
        })();
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
export function generateIdempotencyKey(userId: string, operation: string, data: unknown): string {
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
