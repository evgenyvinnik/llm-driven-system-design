/**
 * Idempotency Module
 *
 * Prevents duplicate comment submissions using idempotency keys stored in Redis.
 * When a client submits a comment with an idempotency key, we store the result
 * and return it for any subsequent requests with the same key.
 *
 * This is critical for live events where network issues may cause retries.
 * Without idempotency, a user might accidentally post the same comment multiple times.
 *
 * @module shared/idempotency
 */

import { redis } from '../utils/redis.js';
import { logger } from './logger.js';
import { idempotencyDuplicatesCounter } from './metrics.js';

/** Default TTL for idempotency keys (5 minutes) */
const DEFAULT_TTL_SECONDS = 300;

/**
 * Result of checking an idempotency key.
 */
export interface IdempotencyResult<T> {
  /** Whether this is a duplicate request */
  isDuplicate: boolean;
  /** The stored result if duplicate, undefined otherwise */
  storedResult?: T;
}

/**
 * Stores the result of an operation with an idempotency key.
 * Subsequent requests with the same key will receive this result.
 *
 * @param key - Unique idempotency key (typically from client request header)
 * @param result - The result to store
 * @param ttlSeconds - How long to remember this key (default: 5 minutes)
 *
 * @example
 * const key = req.headers['x-idempotency-key'] as string;
 * const comment = await commentService.createComment(...);
 * await storeIdempotencyResult(key, comment);
 */
export async function storeIdempotencyResult<T>(
  key: string,
  result: T,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): Promise<void> {
  const redisKey = `idempotency:${key}`;
  try {
    await redis.setex(redisKey, ttlSeconds, JSON.stringify(result));
    logger.debug({ idempotencyKey: key }, 'Stored idempotency result');
  } catch (error) {
    // Don't fail the request if we can't store idempotency key
    // Just log and continue - worst case is a duplicate if retried
    logger.warn({ error, idempotencyKey: key }, 'Failed to store idempotency result');
  }
}

/**
 * Checks if an idempotency key has already been processed.
 *
 * @param key - Idempotency key to check
 * @returns Object indicating if duplicate and the stored result if so
 *
 * @example
 * const key = req.headers['x-idempotency-key'] as string;
 * if (key) {
 *   const { isDuplicate, storedResult } = await checkIdempotencyKey(key);
 *   if (isDuplicate) {
 *     return res.json(storedResult); // Return cached result
 *   }
 * }
 */
export async function checkIdempotencyKey<T>(key: string): Promise<IdempotencyResult<T>> {
  const redisKey = `idempotency:${key}`;
  try {
    const stored = await redis.get(redisKey);
    if (stored) {
      logger.info({ idempotencyKey: key }, 'Duplicate request detected via idempotency key');
      idempotencyDuplicatesCounter.inc();
      return {
        isDuplicate: true,
        storedResult: JSON.parse(stored) as T,
      };
    }
  } catch (error) {
    // If Redis fails, we proceed with the request
    // Better to risk a duplicate than to fail the request entirely
    logger.warn({ error, idempotencyKey: key }, 'Failed to check idempotency key');
  }
  return { isDuplicate: false };
}

/**
 * Generates an idempotency key from request parameters.
 * Used as a fallback when client doesn't provide an explicit key.
 *
 * Key format: {userId}:{streamId}:{contentHash}:{timestamp_bucket}
 * Timestamp is bucketed to 1-second windows to catch rapid duplicates.
 *
 * @param userId - User making the request
 * @param streamId - Target stream
 * @param content - Comment content
 * @returns Generated idempotency key
 */
export function generateIdempotencyKey(
  userId: string,
  streamId: string,
  content: string
): string {
  // Simple hash of content (not cryptographic, just for deduplication)
  const contentHash = hashContent(content);
  // Bucket to 1-second windows
  const timestampBucket = Math.floor(Date.now() / 1000);
  return `${userId}:${streamId}:${contentHash}:${timestampBucket}`;
}

/**
 * Simple non-cryptographic hash for content deduplication.
 * Uses djb2 algorithm for fast, reasonable distribution.
 */
function hashContent(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Deletes an idempotency key (useful for testing or cleanup).
 *
 * @param key - Idempotency key to delete
 */
export async function deleteIdempotencyKey(key: string): Promise<void> {
  const redisKey = `idempotency:${key}`;
  await redis.del(redisKey);
}
