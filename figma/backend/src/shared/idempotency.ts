/**
 * Idempotency service for ensuring operation deduplication.
 * Uses Redis to track processed idempotency keys with TTL expiration.
 * Enables safe retries of create/update operations in CRDT-based collaboration.
 */
import redis from '../db/redis.js';
import { logger } from './logger.js';
import { idempotencyCounter } from './metrics.js';

/**
 * Configuration for idempotency keys.
 */
export interface IdempotencyConfig {
  /** Time-to-live for idempotency keys in seconds (default: 300 = 5 minutes) */
  ttlSeconds: number;
  /** Key prefix for namespacing in Redis */
  keyPrefix: string;
}

/**
 * Default idempotency configuration.
 */
const defaultConfig: IdempotencyConfig = {
  ttlSeconds: 300, // 5 minutes
  keyPrefix: 'idempotency',
};

/**
 * Result of an idempotency check.
 */
export interface IdempotencyResult {
  /** Whether this is a new operation that should be processed */
  isNew: boolean;
  /** The cached result if this is a duplicate */
  cachedResult?: unknown;
}

/**
 * Checks if an operation with the given idempotency key has already been processed.
 * If not processed, marks it as in-progress to prevent concurrent processing.
 * @param idempotencyKey - Unique key for the operation (typically UUID)
 * @param config - Idempotency configuration
 * @returns Promise resolving to idempotency check result
 */
export async function checkIdempotency(
  idempotencyKey: string,
  config: Partial<IdempotencyConfig> = {}
): Promise<IdempotencyResult> {
  const opts = { ...defaultConfig, ...config };
  const redisKey = `${opts.keyPrefix}:${idempotencyKey}`;

  try {
    // Try to set the key with NX (only if not exists)
    const result = await redis.set(redisKey, 'processing', 'EX', opts.ttlSeconds, 'NX');

    if (result === 'OK') {
      // New operation - proceed with processing
      idempotencyCounter.inc({ result: 'processed' });
      logger.debug({ idempotencyKey }, 'New idempotency key, processing operation');
      return { isNew: true };
    } else {
      // Duplicate - check for cached result
      const cachedValue = await redis.get(redisKey);
      idempotencyCounter.inc({ result: 'deduplicated' });
      logger.debug({ idempotencyKey }, 'Duplicate idempotency key, skipping operation');

      if (cachedValue && cachedValue !== 'processing') {
        try {
          return { isNew: false, cachedResult: JSON.parse(cachedValue) };
        } catch {
          return { isNew: false };
        }
      }

      return { isNew: false };
    }
  } catch (error) {
    // On Redis failure, allow the operation to proceed
    // This trades off potential duplicates for availability
    logger.error({ idempotencyKey, error }, 'Failed to check idempotency, allowing operation');
    return { isNew: true };
  }
}

/**
 * Stores the result of a successful operation for future duplicate requests.
 * Updates the idempotency key from 'processing' to the actual result.
 * @param idempotencyKey - The operation's idempotency key
 * @param result - The result to cache for duplicate requests
 * @param config - Idempotency configuration
 */
export async function storeIdempotencyResult(
  idempotencyKey: string,
  result: unknown,
  config: Partial<IdempotencyConfig> = {}
): Promise<void> {
  const opts = { ...defaultConfig, ...config };
  const redisKey = `${opts.keyPrefix}:${idempotencyKey}`;

  try {
    await redis.setex(redisKey, opts.ttlSeconds, JSON.stringify(result));
    logger.debug({ idempotencyKey }, 'Stored idempotency result');
  } catch (error) {
    // Non-critical failure - operation was already processed
    logger.warn({ idempotencyKey, error }, 'Failed to store idempotency result');
  }
}

/**
 * Removes an idempotency key, allowing the operation to be retried.
 * Used when an operation fails and needs to be retried.
 * @param idempotencyKey - The operation's idempotency key
 * @param config - Idempotency configuration
 */
export async function clearIdempotency(
  idempotencyKey: string,
  config: Partial<IdempotencyConfig> = {}
): Promise<void> {
  const opts = { ...defaultConfig, ...config };
  const redisKey = `${opts.keyPrefix}:${idempotencyKey}`;

  try {
    await redis.del(redisKey);
    logger.debug({ idempotencyKey }, 'Cleared idempotency key');
  } catch (error) {
    logger.warn({ idempotencyKey, error }, 'Failed to clear idempotency key');
  }
}

/**
 * Decorator function to add idempotency to an async operation.
 * Wraps the operation with idempotency checking and result caching.
 * @param idempotencyKey - The operation's idempotency key
 * @param operation - The async operation to execute
 * @param config - Idempotency configuration
 * @returns Promise resolving to the operation result (new or cached)
 */
export async function withIdempotency<T>(
  idempotencyKey: string,
  operation: () => Promise<T>,
  config: Partial<IdempotencyConfig> = {}
): Promise<T> {
  const { isNew, cachedResult } = await checkIdempotency(idempotencyKey, config);

  if (!isNew) {
    if (cachedResult !== undefined) {
      return cachedResult as T;
    }
    // Operation was processed but no result cached
    // This could happen if the result storage failed
    // We'll re-execute to get a result
    logger.warn({ idempotencyKey }, 'No cached result for duplicate request, re-executing');
  }

  try {
    const result = await operation();
    await storeIdempotencyResult(idempotencyKey, result, config);
    return result;
  } catch (error) {
    // Clear the idempotency key on failure to allow retries
    await clearIdempotency(idempotencyKey, config);
    throw error;
  }
}

/**
 * Generates a composite idempotency key for file operations.
 * Combines file ID, operation type, and client-generated key.
 * @param fileId - The design file identifier
 * @param operationType - Type of operation (create, update, delete)
 * @param clientKey - Client-generated idempotency key
 * @returns Composite idempotency key
 */
export function generateFileOperationKey(
  fileId: string,
  operationType: string,
  clientKey: string
): string {
  return `file:${fileId}:${operationType}:${clientKey}`;
}

export default {
  checkIdempotency,
  storeIdempotencyResult,
  clearIdempotency,
  withIdempotency,
  generateFileOperationKey,
};
