/**
 * Idempotency service for preventing duplicate trade executions.
 *
 * Critical for financial systems because:
 * 1. Network failures can cause retries that execute the same order twice
 * 2. Users may accidentally double-click submit buttons
 * 3. Load balancers may retry failed requests
 * 4. Client apps may retry on timeout without knowing the server succeeded
 *
 * Implementation:
 * - Client sends a unique idempotency key with each order request
 * - Server stores the key with the order result for 24 hours
 * - Duplicate requests return the cached result instead of re-executing
 * - Uses Redis for fast lookups with automatic expiration
 */

import { redis } from '../redis.js';
import { logger } from './logger.js';
import { idempotencyHitsTotal, idempotencyMissesTotal } from './metrics.js';

/** TTL for idempotency keys (24 hours) */
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** Prefix for idempotency keys in Redis */
const IDEMPOTENCY_PREFIX = 'idempotency:';

/**
 * Status of an idempotent operation.
 */
export type IdempotencyStatus = 'pending' | 'completed' | 'failed';

/**
 * Stored result for an idempotent operation.
 */
export interface IdempotencyRecord<T = unknown> {
  /** Unique idempotency key */
  key: string;
  /** User who initiated the operation */
  userId: string;
  /** Current status of the operation */
  status: IdempotencyStatus;
  /** Result data (if completed) */
  result?: T;
  /** Error message (if failed) */
  error?: string;
  /** Timestamp when the operation was started */
  createdAt: number;
  /** Timestamp when the operation completed */
  completedAt?: number;
}

/**
 * Idempotency service for preventing duplicate operations.
 */
class IdempotencyService {
  /**
   * Checks if an idempotency key already exists.
   * @param key - Unique idempotency key from client
   * @param userId - User making the request
   * @returns Existing record if found, null if new request
   */
  async check<T>(key: string, userId: string): Promise<IdempotencyRecord<T> | null> {
    const redisKey = `${IDEMPOTENCY_PREFIX}${userId}:${key}`;

    try {
      const data = await redis.get(redisKey);

      if (data) {
        const record = JSON.parse(data) as IdempotencyRecord<T>;
        idempotencyHitsTotal.inc();
        logger.debug({ idempotencyKey: key, userId, status: record.status }, 'Idempotency key found');
        return record;
      }

      idempotencyMissesTotal.inc();
      return null;
    } catch (error) {
      logger.error({ error, idempotencyKey: key, userId }, 'Error checking idempotency key');
      // On error, allow the request to proceed (fail open for availability)
      return null;
    }
  }

  /**
   * Starts an idempotent operation by marking it as pending.
   * This prevents race conditions where two concurrent requests both pass the check.
   * @param key - Unique idempotency key from client
   * @param userId - User making the request
   * @returns true if successfully locked, false if already in progress
   */
  async start(key: string, userId: string): Promise<boolean> {
    const redisKey = `${IDEMPOTENCY_PREFIX}${userId}:${key}`;

    try {
      const record: IdempotencyRecord = {
        key,
        userId,
        status: 'pending',
        createdAt: Date.now(),
      };

      // Use SETNX (set if not exists) to atomically acquire the lock
      const result = await redis.set(redisKey, JSON.stringify(record), 'EX', IDEMPOTENCY_TTL_SECONDS, 'NX');

      if (result === 'OK') {
        logger.debug({ idempotencyKey: key, userId }, 'Idempotency lock acquired');
        return true;
      }

      logger.debug({ idempotencyKey: key, userId }, 'Idempotency lock already held');
      return false;
    } catch (error) {
      logger.error({ error, idempotencyKey: key, userId }, 'Error starting idempotent operation');
      // On error, allow the request to proceed
      return true;
    }
  }

  /**
   * Marks an idempotent operation as completed with its result.
   * @param key - Unique idempotency key
   * @param userId - User who made the request
   * @param result - Result to cache for future duplicate requests
   */
  async complete<T>(key: string, userId: string, result: T): Promise<void> {
    const redisKey = `${IDEMPOTENCY_PREFIX}${userId}:${key}`;

    try {
      const record: IdempotencyRecord<T> = {
        key,
        userId,
        status: 'completed',
        result,
        createdAt: Date.now(),
        completedAt: Date.now(),
      };

      await redis.set(redisKey, JSON.stringify(record), 'EX', IDEMPOTENCY_TTL_SECONDS);
      logger.debug({ idempotencyKey: key, userId }, 'Idempotency operation completed');
    } catch (error) {
      logger.error({ error, idempotencyKey: key, userId }, 'Error completing idempotent operation');
    }
  }

  /**
   * Marks an idempotent operation as failed.
   * Failed operations can be retried with the same key.
   * @param key - Unique idempotency key
   * @param userId - User who made the request
   * @param error - Error message
   */
  async fail(key: string, userId: string, error: string): Promise<void> {
    const redisKey = `${IDEMPOTENCY_PREFIX}${userId}:${key}`;

    try {
      const record: IdempotencyRecord = {
        key,
        userId,
        status: 'failed',
        error,
        createdAt: Date.now(),
        completedAt: Date.now(),
      };

      // For failed operations, use shorter TTL (1 hour) to allow retries
      await redis.set(redisKey, JSON.stringify(record), 'EX', 60 * 60);
      logger.debug({ idempotencyKey: key, userId, error }, 'Idempotency operation failed');
    } catch (err) {
      logger.error({ err, idempotencyKey: key, userId }, 'Error marking idempotent operation as failed');
    }
  }

  /**
   * Removes an idempotency key (for cleanup or retry scenarios).
   * @param key - Unique idempotency key
   * @param userId - User who made the request
   */
  async remove(key: string, userId: string): Promise<void> {
    const redisKey = `${IDEMPOTENCY_PREFIX}${userId}:${key}`;

    try {
      await redis.del(redisKey);
      logger.debug({ idempotencyKey: key, userId }, 'Idempotency key removed');
    } catch (error) {
      logger.error({ error, idempotencyKey: key, userId }, 'Error removing idempotency key');
    }
  }
}

/** Singleton idempotency service instance */
export const idempotencyService = new IdempotencyService();

/**
 * Generates a unique idempotency key for client use.
 * Clients can use this or provide their own UUID.
 * @returns Unique idempotency key
 */
export function generateIdempotencyKey(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}
