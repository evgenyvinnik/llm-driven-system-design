import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { redis, cacheGet, cacheSet, cacheDel } from './redis.js';
import { idempotencyCacheHitsTotal } from './metrics.js';
import { indexLogger } from './logger.js';

export interface IdempotencyCacheEntry {
  result: {
    statusCode?: number;
    body: unknown;
  } | null;
  status: 'completed' | 'in_progress';
  timestamp: number;
}

export interface IdempotencyResult {
  replayed?: boolean;
  [key: string]: unknown;
}

/**
 * Redis-backed idempotency store
 * Provides distributed idempotency checking across multiple server instances
 */
class IdempotencyStore {
  private ttlSeconds: number;
  private keyPrefix: string;

  constructor() {
    // Default TTL: 24 hours (in seconds for Redis)
    this.ttlSeconds = 24 * 60 * 60;
    this.keyPrefix = 'idempotency:';
  }

  /**
   * Get a cached result for an idempotency key
   */
  async get(key: string): Promise<IdempotencyCacheEntry | null> {
    const entry = await cacheGet<IdempotencyCacheEntry>(this.keyPrefix + key);
    return entry;
  }

  /**
   * Set a result for an idempotency key
   */
  async set(key: string, result: unknown, status: 'completed' | 'in_progress' = 'completed'): Promise<void> {
    await cacheSet(
      this.keyPrefix + key,
      { result, status, timestamp: Date.now() },
      this.ttlSeconds
    );
  }

  /**
   * Mark an operation as in-progress
   * Uses Redis SETNX for atomic check-and-set
   */
  async markInProgress(key: string): Promise<boolean> {
    const redisKey = this.keyPrefix + key;
    // Use SETNX (SET if Not eXists) for atomic operation
    const result = await redis.setnx(redisKey, JSON.stringify({
      result: null,
      status: 'in_progress',
      timestamp: Date.now()
    }));

    if (result === 1) {
      // Successfully set, add expiry
      await redis.expire(redisKey, this.ttlSeconds);
      return true;
    }
    return false;
  }

  /**
   * Remove an idempotency key (for failed operations that should be retried)
   */
  async remove(key: string): Promise<void> {
    await cacheDel(this.keyPrefix + key);
  }

  /**
   * Get the approximate number of cached entries (for monitoring)
   */
  async size(): Promise<number> {
    const keys = await redis.keys(this.keyPrefix + '*');
    return keys.length;
  }

  /**
   * Stop the store (no-op for Redis, kept for API compatibility)
   */
  stop(): void {
    // Redis handles its own connection management
  }
}

// Singleton store instance
const store = new IdempotencyStore();

/**
 * Generate an idempotency key from request data
 */
export function generateIdempotencyKey(operation: string, data: unknown): string {
  const hash = crypto.createHash('sha256');
  hash.update(operation);
  hash.update(JSON.stringify(data));
  return `${operation}:${hash.digest('hex').substring(0, 32)}`;
}

/**
 * Express middleware for handling idempotency
 * Checks Idempotency-Key header and returns cached results if available
 */
export function idempotencyMiddleware(operationType: string = 'unknown') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

    if (!idempotencyKey) {
      // No idempotency key provided, proceed normally
      return next();
    }

    // Check for cached result
    const cached = await store.get(idempotencyKey);

    if (cached) {
      if (cached.status === 'in_progress') {
        // Operation is still in progress
        res.status(409).json({
          error: 'Request with this idempotency key is still in progress',
          code: 'OPERATION_IN_PROGRESS',
          idempotencyKey
        });
        return;
      }

      // Return cached result
      idempotencyCacheHitsTotal.labels(operationType).inc();
      indexLogger.info({
        idempotencyKey,
        operationType,
        cacheHit: true
      }, 'Idempotency cache hit');

      res.set('X-Idempotency-Key', idempotencyKey);
      res.set('X-Idempotency-Replayed', 'true');
      const result = cached.result as { statusCode?: number; body: unknown } | null;
      res.status(result?.statusCode || 200).json(result?.body);
      return;
    }

    // Mark operation as in progress
    const marked = await store.markInProgress(idempotencyKey);
    if (!marked) {
      // Race condition: another request just started
      res.status(409).json({
        error: 'Request with this idempotency key is being processed',
        code: 'OPERATION_IN_PROGRESS',
        idempotencyKey
      });
      return;
    }

    // Store original json method to capture response
    const originalJson = res.json.bind(res);
    let responseBody: unknown = null;
    let responseStatus = 200;

    res.json = (body: unknown): Response => {
      responseBody = body;
      responseStatus = res.statusCode;
      return originalJson(body);
    };

    // Handle response finish to cache result
    res.on('finish', async () => {
      if (responseBody !== null) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          // Only cache successful responses
          await store.set(idempotencyKey, {
            statusCode: responseStatus,
            body: responseBody
          });

          indexLogger.info({
            idempotencyKey,
            operationType,
            cached: true
          }, 'Idempotency result cached');
        } else {
          // Remove failed operations so they can be retried
          await store.remove(idempotencyKey);
        }
      } else {
        // No response body, remove from cache
        await store.remove(idempotencyKey);
      }
    });

    // Add idempotency key to response headers
    res.set('X-Idempotency-Key', idempotencyKey);

    next();
  };
}

/**
 * Wrapper function for idempotent operations
 */
export async function withIdempotency<T extends Record<string, unknown>>(
  idempotencyKey: string | undefined | null,
  operation: () => Promise<T>,
  operationType: string = 'unknown'
): Promise<T & IdempotencyResult> {
  if (!idempotencyKey) {
    // No key, just execute the operation
    return operation() as Promise<T & IdempotencyResult>;
  }

  // Check for cached result
  const cached = await store.get(idempotencyKey);

  if (cached) {
    if (cached.status === 'in_progress') {
      throw new Error('Operation with this idempotency key is still in progress');
    }

    idempotencyCacheHitsTotal.labels(operationType).inc();
    indexLogger.info({
      idempotencyKey,
      operationType,
      cacheHit: true
    }, 'Idempotency cache hit');

    const cachedResult = cached.result as unknown as T;
    return { ...cachedResult, replayed: true };
  }

  // Mark as in progress
  const marked = await store.markInProgress(idempotencyKey);
  if (!marked) {
    throw new Error('Operation with this idempotency key is being processed');
  }

  try {
    const result = await operation();

    // Cache the result
    await store.set(idempotencyKey, result);

    indexLogger.info({
      idempotencyKey,
      operationType,
      cached: true
    }, 'Idempotency result cached');

    return result as T & IdempotencyResult;
  } catch (error) {
    // Remove from cache on failure so operation can be retried
    await store.remove(idempotencyKey);
    throw error;
  }
}

/**
 * Get the idempotency store (for testing/monitoring)
 */
export function getIdempotencyStore(): IdempotencyStore {
  return store;
}

/**
 * Clear the idempotency store (for testing)
 */
export async function clearIdempotencyStore(): Promise<void> {
  const keys = await redis.keys('idempotency:*');
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

export default {
  generateIdempotencyKey,
  idempotencyMiddleware,
  withIdempotency,
  getIdempotencyStore,
  clearIdempotencyStore
};
