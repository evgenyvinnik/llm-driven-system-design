/**
 * Idempotency key management for document operations.
 * Ensures that duplicate requests (retries) produce the same result.
 *
 * WHY: In collaborative editing with OT:
 * 1. Clients may retry operations on network failures
 * 2. Without idempotency, retries cause duplicate text insertion
 * 3. Idempotency keys allow safe retries with consistent results
 *
 * Example: User types "hello", connection drops, client retries.
 * Without idempotency: "hellohello" appears
 * With idempotency: Only "hello" appears (retry returns cached result)
 */

import redis from '../utils/redis.js';
import logger from './logger.js';
import { idempotencyHitsCounter } from './metrics.js';

/**
 * Stored result for an idempotent operation.
 */
interface IdempotencyRecord {
  /** The cached response to return */
  result: unknown;
  /** When the operation was first processed */
  processedAt: string;
  /** HTTP status code if applicable */
  statusCode?: number;
}

/**
 * Default TTL for idempotency keys (1 hour).
 * Long enough for retries, short enough to not waste memory.
 */
const DEFAULT_TTL_SECONDS = 3600;

/**
 * Prefix for idempotency keys in Redis.
 */
const KEY_PREFIX = 'idempotency:';

/**
 * Checks if an operation with this idempotency key has already been processed.
 * Returns the cached result if found.
 *
 * @param key - Client-provided idempotency key
 * @returns Cached result if operation was already processed, null otherwise
 */
export async function getIdempotencyResult(key: string): Promise<IdempotencyRecord | null> {
  try {
    const data = await redis.get(`${KEY_PREFIX}${key}`);
    if (data) {
      idempotencyHitsCounter.inc();
      logger.debug({ idempotency_key: key }, 'Idempotency cache hit');
      return JSON.parse(data) as IdempotencyRecord;
    }
    return null;
  } catch (error) {
    logger.error({ error, idempotency_key: key }, 'Error checking idempotency key');
    // On error, proceed without idempotency (fail open)
    return null;
  }
}

/**
 * Stores the result of an operation for future idempotent requests.
 *
 * @param key - Client-provided idempotency key
 * @param result - The response to cache
 * @param statusCode - HTTP status code if applicable
 * @param ttlSeconds - Time to live for the cached result
 */
export async function setIdempotencyResult(
  key: string,
  result: unknown,
  statusCode?: number,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): Promise<void> {
  try {
    const record: IdempotencyRecord = {
      result,
      processedAt: new Date().toISOString(),
      statusCode,
    };
    await redis.setex(
      `${KEY_PREFIX}${key}`,
      ttlSeconds,
      JSON.stringify(record)
    );
    logger.debug({ idempotency_key: key }, 'Stored idempotency result');
  } catch (error) {
    logger.error({ error, idempotency_key: key }, 'Error storing idempotency result');
    // Non-fatal: operation completed, just won't be idempotent
  }
}

/**
 * Generates an idempotency key for a document operation.
 * Combines user, document, and operation details for uniqueness.
 *
 * @param userId - User performing the operation
 * @param documentId - Document being modified
 * @param operationId - Client-generated unique operation identifier
 * @returns Composite idempotency key
 */
export function generateOperationKey(
  userId: string,
  documentId: string,
  operationId: string
): string {
  return `op:${userId}:${documentId}:${operationId}`;
}

/**
 * Generates an idempotency key for an HTTP request.
 * Uses the client-provided header or generates from request details.
 *
 * @param clientKey - Optional client-provided idempotency key
 * @param method - HTTP method
 * @param path - Request path
 * @param userId - User making the request
 * @returns Idempotency key to use
 */
export function generateRequestKey(
  clientKey: string | undefined,
  method: string,
  path: string,
  userId: string
): string | null {
  // Only create keys for mutating operations
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return null;
  }

  // Prefer client-provided key for true idempotency
  if (clientKey) {
    return `req:${userId}:${clientKey}`;
  }

  // Without client key, we cannot guarantee idempotency
  return null;
}

/**
 * Lock to prevent concurrent processing of the same idempotency key.
 * Uses Redis SETNX for distributed locking.
 *
 * @param key - Idempotency key to lock
 * @param ttlSeconds - Lock timeout
 * @returns True if lock acquired, false if already locked
 */
export async function acquireIdempotencyLock(
  key: string,
  ttlSeconds: number = 30
): Promise<boolean> {
  try {
    const lockKey = `${KEY_PREFIX}lock:${key}`;
    const result = await redis.set(lockKey, '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  } catch (error) {
    logger.error({ error, idempotency_key: key }, 'Error acquiring idempotency lock');
    return true; // Fail open - allow the operation
  }
}

/**
 * Releases the idempotency lock.
 *
 * @param key - Idempotency key to unlock
 */
export async function releaseIdempotencyLock(key: string): Promise<void> {
  try {
    await redis.del(`${KEY_PREFIX}lock:${key}`);
  } catch (error) {
    logger.error({ error, idempotency_key: key }, 'Error releasing idempotency lock');
  }
}

export default {
  getIdempotencyResult,
  setIdempotencyResult,
  generateOperationKey,
  generateRequestKey,
  acquireIdempotencyLock,
  releaseIdempotencyLock,
};
