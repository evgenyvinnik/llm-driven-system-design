import { redis } from '../models/redis.js';
import { logger } from './logger.js';
import crypto from 'crypto';

/**
 * Idempotency Module
 *
 * WHY idempotency for index updates:
 * - Prevent duplicate document indexing on retry
 * - Ensure at-least-once delivery doesn't cause duplicates
 * - Allow safe replay of failed operations
 * - Support distributed workers without coordination
 *
 * Pattern: Each index operation includes an idempotency key.
 * Before executing, we check if the key was already processed.
 * Results are cached for replay on duplicate requests.
 */

const IDEMPOTENCY_PREFIX = 'idem:';
const DEFAULT_TTL = 3600; // 1 hour

/**
 * Generate an idempotency key for a document
 * Uses URL + content hash to detect meaningful changes
 */
export const generateIdempotencyKey = (operation, params) => {
  const data = JSON.stringify({ operation, ...params });
  const hash = crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
  return `${operation}:${hash}`;
};

/**
 * Generate a key specifically for document indexing
 * Based on URL ID and content hash
 */
export const generateDocumentIdempotencyKey = (urlId, contentHash) => {
  return `index:doc:${urlId}:${contentHash || 'nohash'}`;
};

/**
 * Check if an operation was already executed
 * Returns the cached result if found
 */
export const checkIdempotency = async (key) => {
  try {
    const fullKey = `${IDEMPOTENCY_PREFIX}${key}`;
    const cached = await redis.get(fullKey);

    if (cached) {
      const result = JSON.parse(cached);
      logger.debug({ key, cached: true }, 'Idempotency check: operation already executed');
      return {
        executed: true,
        result: result.result,
        executedAt: result.executedAt,
      };
    }

    return { executed: false };
  } catch (error) {
    logger.error({ error: error.message, key }, 'Idempotency check failed');
    // On error, assume not executed (fail open)
    return { executed: false };
  }
};

/**
 * Acquire an idempotency lock before executing
 * Prevents concurrent execution of the same operation
 */
export const acquireIdempotencyLock = async (key, ttlSeconds = 60) => {
  try {
    const lockKey = `${IDEMPOTENCY_PREFIX}lock:${key}`;
    const acquired = await redis.set(lockKey, 'locked', 'EX', ttlSeconds, 'NX');
    return acquired === 'OK';
  } catch (error) {
    logger.error({ error: error.message, key }, 'Failed to acquire idempotency lock');
    return false;
  }
};

/**
 * Release an idempotency lock
 */
export const releaseIdempotencyLock = async (key) => {
  try {
    const lockKey = `${IDEMPOTENCY_PREFIX}lock:${key}`;
    await redis.del(lockKey);
  } catch (error) {
    logger.error({ error: error.message, key }, 'Failed to release idempotency lock');
  }
};

/**
 * Record a completed operation for idempotency
 */
export const recordIdempotencyResult = async (key, result, ttlSeconds = DEFAULT_TTL) => {
  try {
    const fullKey = `${IDEMPOTENCY_PREFIX}${key}`;
    const data = {
      result,
      executedAt: new Date().toISOString(),
    };
    await redis.setex(fullKey, ttlSeconds, JSON.stringify(data));
    logger.debug({ key }, 'Recorded idempotency result');
  } catch (error) {
    logger.error({ error: error.message, key }, 'Failed to record idempotency result');
  }
};

/**
 * Execute an operation with idempotency guarantee
 * If the operation was already executed, returns the cached result
 */
export const withIdempotency = async (key, operation, options = {}) => {
  const { ttl = DEFAULT_TTL, lockTimeout = 60 } = options;

  // Check if already executed
  const cached = await checkIdempotency(key);
  if (cached.executed) {
    logger.info({ key, executedAt: cached.executedAt }, 'Returning cached idempotent result');
    return {
      ...cached.result,
      idempotent: true,
      cachedAt: cached.executedAt,
    };
  }

  // Try to acquire lock
  const lockAcquired = await acquireIdempotencyLock(key, lockTimeout);
  if (!lockAcquired) {
    // Another process is executing this operation
    // Wait briefly and check again
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const rechecked = await checkIdempotency(key);
    if (rechecked.executed) {
      return {
        ...rechecked.result,
        idempotent: true,
        cachedAt: rechecked.executedAt,
      };
    }

    // Still not complete - throw error to trigger retry
    throw new Error(`Operation ${key} is already in progress`);
  }

  try {
    // Execute the operation
    const result = await operation();

    // Record the result
    await recordIdempotencyResult(key, result, ttl);

    // Release the lock
    await releaseIdempotencyLock(key);

    return { ...result, idempotent: false };
  } catch (error) {
    // Release lock on error to allow retry
    await releaseIdempotencyLock(key);
    throw error;
  }
};

/**
 * Batch idempotency for bulk operations
 * Filters out documents that have already been indexed
 */
export const filterAlreadyIndexed = async (documents, keyGenerator) => {
  if (documents.length === 0) return documents;

  try {
    const keys = documents.map((doc) => `${IDEMPOTENCY_PREFIX}${keyGenerator(doc)}`);
    const results = await redis.mget(keys);

    const needsIndexing = documents.filter((doc, index) => !results[index]);

    logger.info(
      {
        total: documents.length,
        alreadyIndexed: documents.length - needsIndexing.length,
        needsIndexing: needsIndexing.length,
      },
      'Filtered documents for indexing'
    );

    return needsIndexing;
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to filter already indexed documents');
    // On error, return all documents
    return documents;
  }
};

/**
 * Mark multiple documents as indexed
 */
export const markBatchAsIndexed = async (documents, keyGenerator, ttl = DEFAULT_TTL) => {
  if (documents.length === 0) return;

  try {
    const pipeline = redis.pipeline();

    for (const doc of documents) {
      const key = `${IDEMPOTENCY_PREFIX}${keyGenerator(doc)}`;
      const data = {
        result: { indexed: true, urlId: doc.url_id },
        executedAt: new Date().toISOString(),
      };
      pipeline.setex(key, ttl, JSON.stringify(data));
    }

    await pipeline.exec();
    logger.debug({ count: documents.length }, 'Marked batch as indexed');
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to mark batch as indexed');
  }
};
