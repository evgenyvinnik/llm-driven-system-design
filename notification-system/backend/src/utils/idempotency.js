import { redis } from './redis.js';
import { createLogger } from './logger.js';
import { idempotencyCacheHits } from './metrics.js';

const log = createLogger('idempotency');

// Default TTL for idempotency keys: 24 hours
const DEFAULT_TTL_SECONDS = 86400;

/**
 * Idempotency service for ensuring exactly-once processing of notifications.
 *
 * Uses Redis to store idempotency keys with the following pattern:
 * - Key: idempotency:{key}
 * - Value: JSON containing the result and metadata
 * - TTL: 24 hours (configurable)
 *
 * This prevents duplicate notification sends when:
 * - Client retries due to network timeout
 * - Service restarts mid-processing
 * - Load balancer routes same request to different instances
 */
export class IdempotencyService {
  constructor(options = {}) {
    this.ttlSeconds = options.ttlSeconds || DEFAULT_TTL_SECONDS;
    this.keyPrefix = options.keyPrefix || 'idempotency';
  }

  /**
   * Build the Redis key for an idempotency key
   *
   * @param {string} key - The idempotency key
   * @returns {string}
   */
  buildKey(key) {
    return `${this.keyPrefix}:${key}`;
  }

  /**
   * Check if a request with the given idempotency key was already processed.
   * If so, return the cached result. Otherwise, return null.
   *
   * @param {string} idempotencyKey - Unique key for this request
   * @returns {Promise<{found: boolean, result: any|null, status: string|null}>}
   */
  async check(idempotencyKey) {
    if (!idempotencyKey) {
      return { found: false, result: null, status: null };
    }

    const redisKey = this.buildKey(idempotencyKey);

    try {
      const cached = await redis.get(redisKey);

      if (cached) {
        const parsed = JSON.parse(cached);

        // Check if the request is still in progress
        if (parsed.status === 'processing') {
          log.info({ idempotencyKey }, 'Request is still being processed');
          return { found: true, result: null, status: 'processing' };
        }

        // Request completed - return cached result
        log.info({ idempotencyKey }, 'Returning cached result for idempotent request');
        idempotencyCacheHits.inc();

        return { found: true, result: parsed.result, status: 'completed' };
      }

      return { found: false, result: null, status: null };
    } catch (error) {
      log.error({ err: error, idempotencyKey }, 'Error checking idempotency key');
      // On error, proceed with processing to avoid blocking
      return { found: false, result: null, status: null };
    }
  }

  /**
   * Mark a request as in-progress. This is used to detect concurrent duplicate requests.
   *
   * Uses SET NX to ensure only one instance can claim the key.
   *
   * @param {string} idempotencyKey - Unique key for this request
   * @returns {Promise<boolean>} - True if successfully claimed, false if already processing
   */
  async markProcessing(idempotencyKey) {
    if (!idempotencyKey) {
      return true; // No idempotency key means we always process
    }

    const redisKey = this.buildKey(idempotencyKey);

    try {
      // Use NX to only set if not exists, with a short TTL for processing state
      // This prevents race conditions between concurrent requests
      const processingTtl = 300; // 5 minutes max processing time
      const value = JSON.stringify({
        status: 'processing',
        startedAt: Date.now(),
      });

      const result = await redis.set(redisKey, value, 'EX', processingTtl, 'NX');

      if (result === 'OK') {
        log.debug({ idempotencyKey }, 'Claimed idempotency key for processing');
        return true;
      }

      log.info({ idempotencyKey }, 'Idempotency key already claimed by another request');
      return false;
    } catch (error) {
      log.error({ err: error, idempotencyKey }, 'Error marking idempotency key as processing');
      // On error, proceed with processing
      return true;
    }
  }

  /**
   * Store the result for an idempotency key after successful processing.
   *
   * @param {string} idempotencyKey - Unique key for this request
   * @param {any} result - The result to cache
   * @param {number} ttlSeconds - Optional TTL override
   */
  async complete(idempotencyKey, result, ttlSeconds = null) {
    if (!idempotencyKey) {
      return;
    }

    const redisKey = this.buildKey(idempotencyKey);
    const ttl = ttlSeconds || this.ttlSeconds;

    try {
      const value = JSON.stringify({
        status: 'completed',
        result,
        completedAt: Date.now(),
      });

      await redis.setex(redisKey, ttl, value);

      log.debug({ idempotencyKey, ttl }, 'Stored idempotency result');
    } catch (error) {
      log.error({ err: error, idempotencyKey }, 'Error storing idempotency result');
      // Non-fatal - worst case is the request might be reprocessed
    }
  }

  /**
   * Remove the idempotency key (e.g., on processing failure that should be retried)
   *
   * @param {string} idempotencyKey - Unique key for this request
   */
  async clear(idempotencyKey) {
    if (!idempotencyKey) {
      return;
    }

    const redisKey = this.buildKey(idempotencyKey);

    try {
      await redis.del(redisKey);
      log.debug({ idempotencyKey }, 'Cleared idempotency key');
    } catch (error) {
      log.error({ err: error, idempotencyKey }, 'Error clearing idempotency key');
    }
  }

  /**
   * Execute an operation with idempotency protection.
   *
   * Workflow:
   * 1. Check if already processed -> return cached result
   * 2. Mark as processing (with NX lock)
   * 3. Execute operation
   * 4. Store result on success, clear on retryable failure
   *
   * @param {string} idempotencyKey - Unique key for this request
   * @param {Function} operation - Async operation to execute
   * @returns {Promise<{result: any, cached: boolean}>}
   */
  async executeWithIdempotency(idempotencyKey, operation) {
    // Step 1: Check for existing result
    const existing = await this.check(idempotencyKey);

    if (existing.found && existing.status === 'completed') {
      return { result: existing.result, cached: true };
    }

    if (existing.found && existing.status === 'processing') {
      // Another request is processing - return a conflict response
      throw new IdempotencyConflictError(idempotencyKey);
    }

    // Step 2: Try to claim the key
    const claimed = await this.markProcessing(idempotencyKey);

    if (!claimed) {
      throw new IdempotencyConflictError(idempotencyKey);
    }

    try {
      // Step 3: Execute the operation
      const result = await operation();

      // Step 4: Store the result
      await this.complete(idempotencyKey, result);

      return { result, cached: false };
    } catch (error) {
      // On retryable errors, clear the key so the request can be retried
      if (error.retryable) {
        await this.clear(idempotencyKey);
      } else {
        // For non-retryable errors, store the error as the result
        await this.complete(idempotencyKey, {
          error: true,
          message: error.message,
          code: error.code,
        });
      }
      throw error;
    }
  }

  /**
   * Generate an idempotency key from request parameters.
   * Useful when clients don't provide their own idempotency key.
   *
   * @param {Object} params - Parameters to hash
   * @returns {string}
   */
  generateKey(params) {
    const data = JSON.stringify(params);
    // Simple hash for deduplication
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return `generated:${Math.abs(hash).toString(16)}`;
  }
}

/**
 * Error thrown when a duplicate request is detected while processing
 */
export class IdempotencyConflictError extends Error {
  constructor(idempotencyKey) {
    super(`Request with idempotency key ${idempotencyKey} is already being processed`);
    this.name = 'IdempotencyConflictError';
    this.idempotencyKey = idempotencyKey;
    this.statusCode = 409; // Conflict
    this.retryable = true;
  }
}

// Singleton instance
export const idempotencyService = new IdempotencyService();

export default idempotencyService;
