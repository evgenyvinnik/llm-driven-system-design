/**
 * @fileoverview Idempotency handling for critical operations.
 * Prevents duplicate processing of requests (e.g., double purchases)
 * using Redis-backed idempotency keys.
 */

import { redis } from '../config/redis.js';
import { logger } from './logger.js';
import { idempotencyHits } from './metrics.js';
import { v4 as uuid } from 'uuid';

// =============================================================================
// Configuration
// =============================================================================

/**
 * Default TTL for idempotency keys (24 hours in seconds).
 */
const DEFAULT_TTL = 86400;

/**
 * Lock timeout for preventing concurrent processing (30 seconds).
 */
const LOCK_TIMEOUT = 30;

// =============================================================================
// Types
// =============================================================================

/**
 * Result of an idempotent operation.
 */
export interface IdempotentResult<T> {
  /** Whether this was a cached (duplicate) response */
  cached: boolean;
  /** The operation result */
  data: T;
  /** The idempotency key used */
  idempotencyKey: string;
}

/**
 * Idempotency check result.
 */
export type IdempotencyStatus<T> =
  | { status: 'new'; lockAcquired: true; key: string }
  | { status: 'duplicate'; cachedResult: T; key: string }
  | { status: 'in_progress'; key: string };

/**
 * Options for idempotent operations.
 */
export interface IdempotencyOptions {
  /** TTL for the idempotency key in seconds (default: 86400 = 24 hours) */
  ttlSeconds?: number;
  /** Operation name for logging and metrics */
  operation: string;
}

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Generates a prefixed Redis key for idempotency storage.
 */
function getIdempotencyKey(operation: string, key: string): string {
  return `idempotency:${operation}:${key}`;
}

/**
 * Generates a lock key for preventing concurrent processing.
 */
function getLockKey(operation: string, key: string): string {
  return `lock:${operation}:${key}`;
}

/**
 * Checks for an existing idempotent operation and acquires a lock if new.
 *
 * @param idempotencyKey - Client-provided idempotency key
 * @param options - Operation configuration
 * @returns Status indicating if operation is new, duplicate, or in progress
 *
 * @example
 * const status = await checkIdempotency<Purchase>('user123:app456:1704067200', {
 *   operation: 'purchase'
 * });
 *
 * if (status.status === 'duplicate') {
 *   return status.cachedResult;
 * }
 * if (status.status === 'in_progress') {
 *   throw new Error('Request already in progress');
 * }
 * // status.status === 'new' - proceed with operation
 */
export async function checkIdempotency<T>(
  idempotencyKey: string,
  options: IdempotencyOptions
): Promise<IdempotencyStatus<T>> {
  const { operation } = options;
  const redisKey = getIdempotencyKey(operation, idempotencyKey);
  const lockKey = getLockKey(operation, idempotencyKey);

  try {
    // Check for existing result
    const cached = await redis.get(redisKey);
    if (cached) {
      idempotencyHits.inc({ operation });
      logger.info({ operation, idempotencyKey }, 'Idempotent request: returning cached result');
      return {
        status: 'duplicate',
        cachedResult: JSON.parse(cached) as T,
        key: idempotencyKey,
      };
    }

    // Try to acquire lock using ioredis syntax
    const lockAcquired = await redis.set(lockKey, '1', 'EX', LOCK_TIMEOUT, 'NX');
    if (!lockAcquired) {
      logger.info({ operation, idempotencyKey }, 'Idempotent request: operation in progress');
      return {
        status: 'in_progress',
        key: idempotencyKey,
      };
    }

    logger.debug({ operation, idempotencyKey }, 'Idempotency lock acquired');
    return {
      status: 'new',
      lockAcquired: true,
      key: idempotencyKey,
    };
  } catch (error) {
    logger.error({ operation, idempotencyKey, error: (error as Error).message }, 'Idempotency check failed');
    // On Redis failure, proceed with operation but log warning
    // This prioritizes availability over strict idempotency
    return {
      status: 'new',
      lockAcquired: true,
      key: idempotencyKey,
    };
  }
}

/**
 * Stores the result of an idempotent operation.
 *
 * @param idempotencyKey - The idempotency key
 * @param result - The operation result to cache
 * @param options - Operation configuration
 */
export async function storeIdempotentResult<T>(
  idempotencyKey: string,
  result: T,
  options: IdempotencyOptions
): Promise<void> {
  const { operation, ttlSeconds = DEFAULT_TTL } = options;
  const redisKey = getIdempotencyKey(operation, idempotencyKey);
  const lockKey = getLockKey(operation, idempotencyKey);

  try {
    // Store result
    await redis.setex(redisKey, ttlSeconds, JSON.stringify(result));

    // Release lock
    await redis.del(lockKey);

    logger.debug({ operation, idempotencyKey, ttlSeconds }, 'Idempotent result stored');
  } catch (error) {
    logger.error({ operation, idempotencyKey, error: (error as Error).message }, 'Failed to store idempotent result');
    // Still try to release lock
    try {
      await redis.del(lockKey);
    } catch {
      // Ignore lock release failure
    }
  }
}

/**
 * Releases the idempotency lock without storing a result.
 * Use when the operation fails and should be retryable.
 *
 * @param idempotencyKey - The idempotency key
 * @param options - Operation configuration
 */
export async function releaseIdempotencyLock(
  idempotencyKey: string,
  options: IdempotencyOptions
): Promise<void> {
  const { operation } = options;
  const lockKey = getLockKey(operation, idempotencyKey);

  try {
    await redis.del(lockKey);
    logger.debug({ operation, idempotencyKey }, 'Idempotency lock released');
  } catch (error) {
    logger.error({ operation, idempotencyKey, error: (error as Error).message }, 'Failed to release idempotency lock');
  }
}

/**
 * Wraps an async function with idempotency handling.
 *
 * @param fn - The async function to wrap
 * @param getKey - Function to extract idempotency key from arguments
 * @param options - Idempotency options
 * @returns Wrapped function with idempotency
 *
 * @example
 * const idempotentPurchase = withIdempotency(
 *   async (userId: string, appId: string, amount: number) => {
 *     return await processPurchase(userId, appId, amount);
 *   },
 *   (userId, appId) => `${userId}:${appId}:${Math.floor(Date.now() / 60000)}`,
 *   { operation: 'purchase', ttlSeconds: 86400 }
 * );
 */
export function withIdempotency<TArgs extends any[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  getKey: (...args: TArgs) => string,
  options: IdempotencyOptions
): (...args: TArgs) => Promise<IdempotentResult<TResult>> {
  return async (...args: TArgs): Promise<IdempotentResult<TResult>> => {
    const idempotencyKey = getKey(...args);

    const status = await checkIdempotency<TResult>(idempotencyKey, options);

    if (status.status === 'duplicate') {
      return {
        cached: true,
        data: status.cachedResult,
        idempotencyKey,
      };
    }

    if (status.status === 'in_progress') {
      throw new Error('Request already in progress');
    }

    try {
      const result = await fn(...args);
      await storeIdempotentResult(idempotencyKey, result, options);
      return {
        cached: false,
        data: result,
        idempotencyKey,
      };
    } catch (error) {
      await releaseIdempotencyLock(idempotencyKey, options);
      throw error;
    }
  };
}

// =============================================================================
// Express Middleware
// =============================================================================

/**
 * Express middleware for enforcing idempotency on endpoints.
 * Expects idempotency key in header `X-Idempotency-Key` or body field `idempotencyKey`.
 *
 * @param operation - Operation name for key prefixing
 * @returns Express middleware function
 *
 * @example
 * app.post('/api/v1/purchases',
 *   idempotencyMiddleware('purchase'),
 *   async (req, res) => { ... }
 * );
 */
export function idempotencyMiddleware(operation: string) {
  return async (req: any, res: any, next: any) => {
    // Get idempotency key from header or body
    const idempotencyKey = req.headers['x-idempotency-key'] || req.body?.idempotencyKey;

    if (!idempotencyKey) {
      // No idempotency key provided, proceed without idempotency
      return next();
    }

    // Include user ID in key for user-scoped idempotency
    const userId = req.user?.id || 'anonymous';
    const fullKey = `${userId}:${idempotencyKey}`;

    const status = await checkIdempotency(fullKey, { operation });

    if (status.status === 'duplicate') {
      const cachedData = status.cachedResult as Record<string, unknown> | null;
      return res.status(200).json({
        ...(cachedData && typeof cachedData === 'object' ? cachedData : { data: cachedData }),
        _idempotent: true,
        _idempotencyKey: idempotencyKey,
      });
    }

    if (status.status === 'in_progress') {
      return res.status(409).json({
        error: 'Request already in progress',
        idempotencyKey,
      });
    }

    // Attach idempotency context to request for later storage
    req.idempotency = {
      key: fullKey,
      operation,
      storeResult: async (result: any) => {
        await storeIdempotentResult(fullKey, result, { operation });
      },
      releaselock: async () => {
        await releaseIdempotencyLock(fullKey, { operation });
      },
    };

    next();
  };
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Generates a time-bucketed idempotency key.
 * Useful for preventing rapid duplicate operations within a time window.
 *
 * @param parts - Key components to join
 * @param bucketMinutes - Time bucket size in minutes (default: 1)
 * @returns Time-bucketed key
 *
 * @example
 * // Prevents duplicate purchases within 1-minute window
 * const key = generateTimeBucketedKey(['user123', 'app456'], 1);
 * // Returns: "user123:app456:28401234" (where last part is minute bucket)
 */
export function generateTimeBucketedKey(parts: string[], bucketMinutes = 1): string {
  const bucket = Math.floor(Date.now() / (bucketMinutes * 60 * 1000));
  return [...parts, bucket.toString()].join(':');
}

/**
 * Generates a unique idempotency key if none provided.
 * Client should ideally provide their own key for true idempotency.
 */
export function generateIdempotencyKey(): string {
  return uuid();
}
