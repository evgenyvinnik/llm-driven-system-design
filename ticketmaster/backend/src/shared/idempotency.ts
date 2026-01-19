/**
 * Idempotency key management for preventing duplicate operations.
 * Critical for checkout operations to prevent double-charging customers.
 *
 * Implementation uses Redis for fast lookup with database fallback for durability.
 * Keys are stored with the operation result, allowing replay of successful operations.
 */
import redis from '../db/redis.js';
import { query } from '../db/pool.js';
import logger, { businessLogger } from './logger.js';
import { idempotencyHits, idempotencyMisses } from './metrics.js';

/** Time-to-live for idempotency keys in Redis (24 hours) */
const IDEMPOTENCY_TTL = 24 * 60 * 60;

/** Result of an idempotent operation */
export interface IdempotencyResult<T> {
  /** Whether this was a cache hit (operation already completed) */
  cached: boolean;
  /** The result data */
  data: T;
  /** The idempotency key used */
  key: string;
}

/** Stored idempotency record structure */
interface IdempotencyRecord {
  key: string;
  result: unknown;
  createdAt: string;
  completedAt: string;
}

/**
 * Checks if an idempotent operation has already been completed.
 * Returns the cached result if found, null otherwise.
 *
 * @param idempotencyKey - The unique key identifying the operation
 * @returns The cached result or null if not found
 */
export async function checkIdempotency<T>(
  idempotencyKey: string
): Promise<IdempotencyResult<T> | null> {
  // Try Redis first (fast path)
  const cached = await redis.get(`idempotency:${idempotencyKey}`);
  if (cached) {
    idempotencyHits.inc();
    const record = JSON.parse(cached) as IdempotencyRecord;
    return {
      cached: true,
      data: record.result as T,
      key: idempotencyKey,
    };
  }

  // Fall back to database
  const result = await query(
    `SELECT result FROM idempotency_keys WHERE key = $1`,
    [idempotencyKey]
  );

  if (result.rows.length > 0) {
    idempotencyHits.inc();
    const data = result.rows[0].result as T;

    // Re-populate Redis cache
    const record: IdempotencyRecord = {
      key: idempotencyKey,
      result: data,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    await redis.setex(
      `idempotency:${idempotencyKey}`,
      IDEMPOTENCY_TTL,
      JSON.stringify(record)
    );

    return {
      cached: true,
      data,
      key: idempotencyKey,
    };
  }

  idempotencyMisses.inc();
  return null;
}

/**
 * Stores the result of an idempotent operation.
 * Saves to both Redis (for fast lookup) and database (for durability).
 *
 * @param idempotencyKey - The unique key identifying the operation
 * @param result - The operation result to store
 */
export async function storeIdempotency<T>(
  idempotencyKey: string,
  result: T
): Promise<void> {
  const now = new Date().toISOString();

  const record: IdempotencyRecord = {
    key: idempotencyKey,
    result,
    createdAt: now,
    completedAt: now,
  };

  // Store in Redis
  await redis.setex(
    `idempotency:${idempotencyKey}`,
    IDEMPOTENCY_TTL,
    JSON.stringify(record)
  );

  // Store in database for durability
  try {
    await query(
      `INSERT INTO idempotency_keys (key, result, created_at, completed_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO NOTHING`,
      [idempotencyKey, JSON.stringify(result), now, now]
    );
  } catch (error) {
    // Log but don't fail - Redis has the data
    logger.warn({
      msg: 'Failed to store idempotency key in database',
      key: idempotencyKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Generates an idempotency key from checkout context.
 * Uses a combination of session ID, event ID, seat IDs, and timestamp.
 *
 * @param sessionId - The user's session ID
 * @param eventId - The event being purchased
 * @param seatIds - Array of seat IDs being purchased
 * @returns A deterministic idempotency key
 */
export function generateCheckoutIdempotencyKey(
  sessionId: string,
  eventId: string,
  seatIds: string[]
): string {
  // Sort seat IDs for deterministic key generation
  const sortedSeats = [...seatIds].sort().join(',');
  return `checkout:${sessionId}:${eventId}:${sortedSeats}`;
}

/**
 * Validates and normalizes an idempotency key.
 * Returns the key if valid, generates one if not provided.
 *
 * @param key - The provided idempotency key (may be undefined)
 * @param fallbackGenerator - Function to generate a key if not provided
 * @returns A valid idempotency key
 */
export function validateIdempotencyKey(
  key: string | undefined,
  fallbackGenerator: () => string
): string {
  if (key && typeof key === 'string' && key.length > 0 && key.length <= 255) {
    return key;
  }
  return fallbackGenerator();
}

/**
 * Decorator for making an async function idempotent.
 * Wraps the function to check for cached results before execution.
 *
 * @param keyGenerator - Function to generate the idempotency key from args
 * @param fn - The async function to make idempotent
 * @returns A wrapped function that is idempotent
 */
export function withIdempotency<TArgs extends unknown[], TResult>(
  keyGenerator: (...args: TArgs) => string,
  fn: (...args: TArgs) => Promise<TResult>
): (...args: TArgs) => Promise<IdempotencyResult<TResult>> {
  return async (...args: TArgs): Promise<IdempotencyResult<TResult>> => {
    const key = keyGenerator(...args);

    // Check for existing result
    const existing = await checkIdempotency<TResult>(key);
    if (existing) {
      return existing;
    }

    // Execute the operation
    const result = await fn(...args);

    // Store the result
    await storeIdempotency(key, result);

    return {
      cached: false,
      data: result,
      key,
    };
  };
}
