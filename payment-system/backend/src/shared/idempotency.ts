import { redis } from '../db/connection.js';
import { logger } from './logger.js';
import { idempotencyCacheTotal } from './metrics.js';

/**
 * Idempotency key management for payment operations.
 *
 * CRITICAL: Idempotency is ESSENTIAL for payment systems because:
 *
 * 1. NETWORK FAILURES: HTTP requests can timeout after the server processed
 *    the payment but before the client received the response. Without
 *    idempotency, retrying would charge the customer twice.
 *
 * 2. CLIENT RETRIES: Mobile apps and browsers often retry failed requests
 *    automatically. Each retry without idempotency = potential duplicate charge.
 *
 * 3. WEBHOOKS: Webhook deliveries are retried on failure. Idempotency ensures
 *    the same event is not processed multiple times.
 *
 * HOW IT WORKS:
 * - Client provides unique Idempotency-Key header (e.g., order ID, UUID)
 * - Server stores key -> response mapping in Redis (24h TTL)
 * - Subsequent requests with same key return cached response
 * - If processing fails, key is NOT stored (allows retry)
 *
 * SCOPE:
 * - Keys are scoped per merchant to prevent cross-merchant conflicts
 * - Different operations use different key prefixes
 */

/** Default TTL for idempotency keys: 24 hours in seconds */
const DEFAULT_TTL_SECONDS = 86400;

/** Prefix for different operation types */
const KEY_PREFIXES = {
  payment: 'idempotency:payment',
  capture: 'idempotency:capture',
  void: 'idempotency:void',
  refund: 'idempotency:refund',
} as const;

export type IdempotencyOperation = keyof typeof KEY_PREFIXES;

/**
 * Result of an idempotency check.
 */
export interface IdempotencyResult<T> {
  /** Whether a cached response was found */
  cached: boolean;
  /** The cached response if found */
  response?: T;
  /** Lock acquired for processing (null if cached or lock failed) */
  lockKey?: string;
}

/**
 * Checks if an operation has already been processed.
 * If not, acquires a distributed lock to prevent duplicate processing.
 *
 * @param operation - Type of operation (payment, capture, void, refund)
 * @param merchantId - Merchant ID for scoping
 * @param idempotencyKey - Client-provided unique key
 * @returns IdempotencyResult with cached response or lock key
 */
export async function checkIdempotency<T>(
  operation: IdempotencyOperation,
  merchantId: string,
  idempotencyKey: string
): Promise<IdempotencyResult<T>> {
  const prefix = KEY_PREFIXES[operation];
  const cacheKey = `${prefix}:${merchantId}:${idempotencyKey}`;
  const lockKey = `lock:${cacheKey}`;

  try {
    // Check for cached response first
    const cached = await redis.get(cacheKey);
    if (cached) {
      idempotencyCacheTotal.labels('hit').inc();
      logger.debug(
        { operation, merchantId, idempotencyKey },
        'Idempotency cache hit - returning cached response'
      );
      return {
        cached: true,
        response: JSON.parse(cached) as T,
      };
    }

    idempotencyCacheTotal.labels('miss').inc();

    // Try to acquire lock for processing
    // NX = only set if not exists, EX = expire in seconds
    const lockAcquired = await redis.set(lockKey, '1', 'EX', 30, 'NX');

    if (!lockAcquired) {
      // Another request is processing this key - wait and check again
      logger.debug(
        { operation, merchantId, idempotencyKey },
        'Idempotency lock exists - request in progress'
      );

      // Poll for cached result (request in progress by another worker)
      await new Promise((resolve) => setTimeout(resolve, 100));
      const retryCache = await redis.get(cacheKey);
      if (retryCache) {
        return {
          cached: true,
          response: JSON.parse(retryCache) as T,
        };
      }

      // If still no result, throw conflict error
      throw new IdempotencyConflictError(
        'Request with this idempotency key is already being processed'
      );
    }

    return {
      cached: false,
      lockKey,
    };
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      throw error;
    }
    logger.error({ error, operation, merchantId }, 'Idempotency check failed');
    throw error;
  }
}

/**
 * Stores the response for a completed idempotent operation.
 * Must be called after successful processing to cache the result.
 *
 * @param operation - Type of operation
 * @param merchantId - Merchant ID for scoping
 * @param idempotencyKey - Client-provided unique key
 * @param response - Response to cache
 * @param ttlSeconds - TTL for the cached response (default: 24 hours)
 */
export async function storeIdempotencyResult<T>(
  operation: IdempotencyOperation,
  merchantId: string,
  idempotencyKey: string,
  response: T,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): Promise<void> {
  const prefix = KEY_PREFIXES[operation];
  const cacheKey = `${prefix}:${merchantId}:${idempotencyKey}`;
  const lockKey = `lock:${cacheKey}`;

  try {
    // Store the response
    await redis.setex(cacheKey, ttlSeconds, JSON.stringify(response));

    // Release the lock
    await redis.del(lockKey);

    logger.debug(
      { operation, merchantId, idempotencyKey, ttlSeconds },
      'Stored idempotency result'
    );
  } catch (error) {
    logger.error({ error, operation, merchantId }, 'Failed to store idempotency result');
    // Don't throw - processing succeeded, just caching failed
    // Next request will process again (safe since operation is idempotent)
  }
}

/**
 * Releases an idempotency lock without storing a result.
 * Use when processing fails and should be retryable.
 *
 * @param lockKey - Lock key returned from checkIdempotency
 */
export async function releaseIdempotencyLock(lockKey: string): Promise<void> {
  try {
    await redis.del(lockKey);
    logger.debug({ lockKey }, 'Released idempotency lock');
  } catch (error) {
    logger.error({ error, lockKey }, 'Failed to release idempotency lock');
  }
}

/**
 * Error thrown when a duplicate request is detected.
 */
export class IdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

/**
 * Decorator/wrapper for idempotent operations.
 * Automatically handles check, store, and lock release.
 *
 * @param operation - Type of operation
 * @param merchantId - Merchant ID for scoping
 * @param idempotencyKey - Client-provided unique key
 * @param fn - The operation to execute
 * @returns Result from cache or fresh execution
 */
export async function withIdempotency<T>(
  operation: IdempotencyOperation,
  merchantId: string,
  idempotencyKey: string | undefined,
  fn: () => Promise<T>
): Promise<{ result: T; fromCache: boolean }> {
  // If no idempotency key provided, just execute
  if (!idempotencyKey) {
    return { result: await fn(), fromCache: false };
  }

  const check = await checkIdempotency<T>(operation, merchantId, idempotencyKey);

  if (check.cached && check.response !== undefined) {
    return { result: check.response, fromCache: true };
  }

  try {
    const result = await fn();

    // Store successful result
    await storeIdempotencyResult(operation, merchantId, idempotencyKey, result);

    return { result, fromCache: false };
  } catch (error) {
    // Release lock on failure so operation can be retried
    if (check.lockKey) {
      await releaseIdempotencyLock(check.lockKey);
    }
    throw error;
  }
}
