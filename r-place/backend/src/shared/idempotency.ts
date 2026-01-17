/**
 * Idempotency key management for pixel placements.
 *
 * Prevents duplicate pixel placements from:
 * - Network retries
 * - Client-side double clicks
 * - Load balancer request duplication
 *
 * Uses Redis to store idempotency keys with short TTL.
 */
import { redis } from '../services/redis.js';
import { logger } from './logger.js';
import { idempotencyCacheHits } from './metrics.js';

/**
 * Prefix for idempotency keys in Redis.
 */
const IDEMPOTENCY_PREFIX = 'idempotency:pixel:';

/**
 * TTL for idempotency keys (10 seconds).
 * Should be longer than the expected retry window but shorter than the cooldown.
 */
const IDEMPOTENCY_TTL_SECONDS = 10;

/**
 * Result of an idempotency check.
 */
export interface IdempotencyResult {
  /** Whether this is a duplicate request. */
  isDuplicate: boolean;
  /** The cached result if this is a duplicate. */
  cachedResult?: {
    success: boolean;
    nextPlacement?: number;
    error?: string;
  };
}

/**
 * Generates an idempotency key for a pixel placement.
 * Key is based on userId, coordinates, color, and a client-provided request ID.
 *
 * @param userId - The user making the request.
 * @param x - X coordinate.
 * @param y - Y coordinate.
 * @param color - Color index.
 * @param requestId - Optional client-provided request ID for exact duplicate detection.
 * @returns The idempotency key.
 */
export function generateIdempotencyKey(
  userId: string,
  x: number,
  y: number,
  color: number,
  requestId?: string
): string {
  if (requestId) {
    // If client provides a request ID, use it for exact duplicate detection
    return `${IDEMPOTENCY_PREFIX}${userId}:${requestId}`;
  }
  // Otherwise, generate a key based on the placement parameters
  // This catches duplicates from the same user placing the same pixel
  return `${IDEMPOTENCY_PREFIX}${userId}:${x}:${y}:${color}`;
}

/**
 * Checks if a request is a duplicate and retrieves cached result if so.
 *
 * @param key - The idempotency key.
 * @returns Idempotency check result.
 */
export async function checkIdempotency(key: string): Promise<IdempotencyResult> {
  try {
    const cached = await redis.get(key);

    if (cached) {
      idempotencyCacheHits.inc();
      logger.debug({ event: 'idempotency_hit', key }, 'Duplicate request detected');

      try {
        const cachedResult = JSON.parse(cached);
        return { isDuplicate: true, cachedResult };
      } catch {
        // Invalid cached value, treat as new request
        return { isDuplicate: false };
      }
    }

    return { isDuplicate: false };
  } catch (error) {
    // On Redis error, allow the request to proceed
    logger.error(
      { event: 'idempotency_check_error', key, error },
      'Failed to check idempotency key'
    );
    return { isDuplicate: false };
  }
}

/**
 * Stores the result of a pixel placement for idempotency.
 *
 * @param key - The idempotency key.
 * @param result - The result to cache.
 */
export async function storeIdempotencyResult(
  key: string,
  result: { success: boolean; nextPlacement?: number; error?: string }
): Promise<void> {
  try {
    await redis.set(key, JSON.stringify(result), 'EX', IDEMPOTENCY_TTL_SECONDS);
    logger.debug({ event: 'idempotency_stored', key }, 'Idempotency result stored');
  } catch (error) {
    // Non-critical error, log and continue
    logger.error(
      { event: 'idempotency_store_error', key, error },
      'Failed to store idempotency result'
    );
  }
}

/**
 * Wrapper for idempotent pixel placement.
 * Checks for duplicates before executing and caches the result after.
 *
 * @param key - The idempotency key.
 * @param operation - The pixel placement operation to execute.
 * @returns The result (either cached or newly executed).
 */
export async function withIdempotency<T extends { success: boolean; nextPlacement?: number; error?: string }>(
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  // Check for duplicate
  const idempotencyResult = await checkIdempotency(key);

  if (idempotencyResult.isDuplicate && idempotencyResult.cachedResult) {
    return idempotencyResult.cachedResult as T;
  }

  // Execute the operation
  const result = await operation();

  // Store result for future duplicate detection
  await storeIdempotencyResult(key, result);

  return result;
}
