/**
 * Distributed locking implementation using Redis.
 * Provides exclusive access to resources across multiple server instances.
 * Critical for preventing seat overselling during high-concurrency scenarios.
 *
 * Uses the Redlock algorithm pattern with single-instance optimization.
 */
import redis from '../db/redis.js';
import { query } from '../db/pool.js';
import logger, { businessLogger } from './logger.js';
import { seatLockAttempts, redisOperationDuration } from './metrics.js';
import { randomBytes } from 'crypto';

/** Default lock TTL in seconds */
const DEFAULT_LOCK_TTL = 600; // 10 minutes

/** Retry configuration for lock acquisition */
interface LockRetryOptions {
  /** Maximum number of retry attempts */
  maxRetries: number;
  /** Delay between retries in ms */
  retryDelay: number;
  /** Add jitter to retry delay */
  jitter: boolean;
}

/** Default retry options */
const DEFAULT_RETRY_OPTIONS: LockRetryOptions = {
  maxRetries: 3,
  retryDelay: 50,
  jitter: true,
};

/** Lock information returned on successful acquisition */
export interface Lock {
  /** The lock key */
  key: string;
  /** Unique token for this lock holder */
  token: string;
  /** Expiration time */
  expiresAt: Date;
}

/**
 * Generates a unique lock token.
 */
function generateLockToken(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Calculates retry delay with optional jitter.
 */
function getRetryDelay(baseDelay: number, attempt: number, jitter: boolean): number {
  const delay = baseDelay * Math.pow(2, attempt); // Exponential backoff
  if (jitter) {
    return delay + Math.random() * delay * 0.5;
  }
  return delay;
}

/**
 * Acquires a distributed lock for a resource.
 * Uses Redis SET NX for atomic acquisition.
 *
 * @param key - The resource key to lock
 * @param ttlSeconds - Lock time-to-live in seconds
 * @param options - Retry options
 * @returns Lock info if acquired, null otherwise
 */
export async function acquireLock(
  key: string,
  ttlSeconds: number = DEFAULT_LOCK_TTL,
  options: Partial<LockRetryOptions> = {}
): Promise<Lock | null> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  const token = generateLockToken();
  const lockKey = `lock:${key}`;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    const start = process.hrtime.bigint();

    try {
      const acquired = await redis.set(
        lockKey,
        token,
        'EX',
        ttlSeconds,
        'NX'
      );

      const duration = Number(process.hrtime.bigint() - start) / 1e9;
      redisOperationDuration.observe({ operation: 'lock_acquire' }, duration);

      if (acquired) {
        return {
          key: lockKey,
          token,
          expiresAt: new Date(Date.now() + ttlSeconds * 1000),
        };
      }

      // Lock not acquired, wait and retry
      if (attempt < opts.maxRetries) {
        const delay = getRetryDelay(opts.retryDelay, attempt, opts.jitter);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } catch (error) {
      logger.error({
        msg: 'Error acquiring lock',
        key,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });

      if (attempt === opts.maxRetries) {
        throw error;
      }
    }
  }

  return null;
}

/**
 * Releases a distributed lock.
 * Only releases if the token matches (prevents releasing someone else's lock).
 *
 * @param lock - The lock to release
 * @returns True if released, false if lock was not held or expired
 */
export async function releaseLock(lock: Lock): Promise<boolean> {
  const start = process.hrtime.bigint();

  try {
    // Use Lua script for atomic check-and-delete
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    const result = await redis.eval(script, 1, lock.key, lock.token);

    const duration = Number(process.hrtime.bigint() - start) / 1e9;
    redisOperationDuration.observe({ operation: 'lock_release' }, duration);

    return result === 1;
  } catch (error) {
    logger.error({
      msg: 'Error releasing lock',
      key: lock.key,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Extends the TTL of an existing lock.
 * Only extends if the token matches.
 *
 * @param lock - The lock to extend
 * @param additionalSeconds - Additional seconds to add to TTL
 * @returns Updated lock info or null if extension failed
 */
export async function extendLock(
  lock: Lock,
  additionalSeconds: number
): Promise<Lock | null> {
  try {
    // Use Lua script for atomic check-and-extend
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("expire", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;

    const result = await redis.eval(
      script,
      1,
      lock.key,
      lock.token,
      additionalSeconds.toString()
    );

    if (result === 1) {
      return {
        ...lock,
        expiresAt: new Date(Date.now() + additionalSeconds * 1000),
      };
    }
    return null;
  } catch (error) {
    logger.error({
      msg: 'Error extending lock',
      key: lock.key,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Acquires locks for multiple seats atomically.
 * All locks must be acquired or none are.
 *
 * @param eventId - The event ID
 * @param seatIds - Array of seat IDs to lock
 * @param sessionId - Session ID for tracking the lock holder
 * @param ttlSeconds - Lock TTL
 * @returns Array of locks if all acquired, null if any failed
 */
export async function acquireSeatLocks(
  eventId: string,
  seatIds: string[],
  sessionId: string,
  ttlSeconds: number = DEFAULT_LOCK_TTL
): Promise<Lock[] | null> {
  const locks: Lock[] = [];

  for (const seatId of seatIds) {
    const key = `seat:${eventId}:${seatId}`;
    const lock = await acquireLock(key, ttlSeconds);

    if (lock) {
      locks.push(lock);
      seatLockAttempts.inc({ event_id: eventId, result: 'success' });
    } else {
      // Failed to acquire this lock, release all previously acquired
      seatLockAttempts.inc({ event_id: eventId, result: 'failure' });
      businessLogger.lockContention({
        eventId,
        seatId,
        attempts: DEFAULT_RETRY_OPTIONS.maxRetries + 1,
      });

      // Release all acquired locks
      for (const acquiredLock of locks) {
        await releaseLock(acquiredLock);
      }

      return null;
    }
  }

  return locks;
}

/**
 * Releases all seat locks.
 *
 * @param locks - Array of locks to release
 */
export async function releaseSeatLocks(locks: Lock[]): Promise<void> {
  await Promise.all(locks.map((lock) => releaseLock(lock)));
}

/**
 * Executes an operation while holding a distributed lock.
 * Automatically acquires and releases the lock.
 *
 * @param key - The resource key to lock
 * @param operation - The operation to execute
 * @param ttlSeconds - Lock TTL
 * @returns The operation result
 * @throws Error if lock cannot be acquired
 */
export async function withLock<T>(
  key: string,
  operation: () => Promise<T>,
  ttlSeconds: number = DEFAULT_LOCK_TTL
): Promise<T> {
  const lock = await acquireLock(key, ttlSeconds);

  if (!lock) {
    throw new Error(`Failed to acquire lock for ${key}`);
  }

  try {
    return await operation();
  } finally {
    await releaseLock(lock);
  }
}

/**
 * Circuit breaker for Redis failures.
 * Falls back to PostgreSQL advisory locks when Redis is unavailable.
 */
let redisFailures = 0;
let circuitOpen = false;
let circuitOpenedAt: number | null = null;

const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_RESET_TIME = 30000; // 30 seconds

/**
 * Acquires a seat lock with database fallback.
 * Uses Redis by default, falls back to PostgreSQL advisory locks on failure.
 *
 * @param eventId - The event ID
 * @param seatId - The seat ID
 * @param sessionId - The session ID
 * @param ttlSeconds - Lock TTL (only applies to Redis)
 * @returns Lock info if acquired, null otherwise
 */
export async function acquireSeatLockWithFallback(
  eventId: string,
  seatId: string,
  sessionId: string,
  ttlSeconds: number = DEFAULT_LOCK_TTL
): Promise<Lock | null> {
  // Check circuit breaker
  if (circuitOpen) {
    if (circuitOpenedAt && Date.now() - circuitOpenedAt >= CIRCUIT_RESET_TIME) {
      circuitOpen = false;
      redisFailures = 0;
    } else {
      return acquireDatabaseLock(eventId, seatId);
    }
  }

  try {
    const key = `seat:${eventId}:${seatId}`;
    const lock = await acquireLock(key, ttlSeconds);
    redisFailures = 0;
    return lock;
  } catch (error) {
    redisFailures++;

    if (redisFailures >= CIRCUIT_THRESHOLD) {
      circuitOpen = true;
      circuitOpenedAt = Date.now();
      businessLogger.redisFallback({
        operation: 'seat_lock',
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return acquireDatabaseLock(eventId, seatId);
  }
}

/**
 * Acquires a PostgreSQL advisory lock as fallback.
 */
async function acquireDatabaseLock(
  eventId: string,
  seatId: string
): Promise<Lock | null> {
  // Convert string IDs to a numeric hash for advisory lock
  const lockId = hashToInt(`${eventId}:${seatId}`);

  try {
    const result = await query(
      'SELECT pg_try_advisory_lock($1) as acquired',
      [lockId]
    );

    if (result.rows[0]?.acquired) {
      return {
        key: `db_lock:${eventId}:${seatId}`,
        token: lockId.toString(),
        expiresAt: new Date(Date.now() + 600000), // 10 minutes (advisory locks don't expire)
      };
    }
    return null;
  } catch (error) {
    logger.error({
      msg: 'Error acquiring database advisory lock',
      eventId,
      seatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Hashes a string to a 32-bit integer for PostgreSQL advisory locks.
 */
function hashToInt(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}
