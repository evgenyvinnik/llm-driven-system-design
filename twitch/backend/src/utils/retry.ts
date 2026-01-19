/**
 * Retry Logic with Exponential Backoff
 *
 * Provides resilient execution of operations with:
 * - Exponential backoff with jitter
 * - Configurable retry conditions
 * - Integration with idempotency keys
 * - Detailed logging of retry attempts
 */
import type { RedisClientType } from 'redis';
import { logger } from './logger.js';

interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  jitterFactor?: number;
  retryableErrors?: string[];
  retryableStatusCodes?: number[];
}

interface RetryableError extends Error {
  code?: string;
  status?: number;
  statusCode?: number;
  retryable?: boolean;
}

// Default retry configuration
const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'cacheTtlSeconds'>> = {
  maxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  jitterFactor: 0.1,
  retryableErrors: ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EPIPE'],
  retryableStatusCodes: [408, 429, 500, 502, 503, 504]
};

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateDelay(attempt: number, options: Required<Omit<RetryOptions, 'cacheTtlSeconds'>>): number {
  const { baseDelayMs, maxDelayMs, backoffMultiplier, jitterFactor } = options;

  // Exponential backoff
  const exponentialDelay = baseDelayMs * Math.pow(backoffMultiplier, attempt);

  // Cap at maximum delay
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

  // Add jitter to prevent thundering herd
  const jitter = cappedDelay * jitterFactor * Math.random();

  return Math.round(cappedDelay + jitter);
}

/**
 * Determine if an error is retryable
 */
function isRetryableError(error: RetryableError, options: Required<Omit<RetryOptions, 'cacheTtlSeconds'>>): boolean {
  const { retryableErrors, retryableStatusCodes } = options;

  // Check error code
  if (error.code && retryableErrors.includes(error.code)) {
    return true;
  }

  // Check HTTP status code
  if (error.status && retryableStatusCodes.includes(error.status)) {
    return true;
  }

  if (error.statusCode && retryableStatusCodes.includes(error.statusCode)) {
    return true;
  }

  // Check explicit retryable flag
  if (error.retryable === true) {
    return true;
  }

  // Check for transient errors
  if (error.message) {
    const transientPatterns = [
      /connection reset/i,
      /socket hang up/i,
      /ECONNRESET/,
      /ETIMEDOUT/,
      /ECONNREFUSED/,
      /network error/i,
      /timeout/i
    ];

    for (const pattern of transientPatterns) {
      if (pattern.test(error.message)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Execute an operation with retry logic
 */
async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options } as Required<Omit<RetryOptions, 'cacheTtlSeconds'>>;
  const { maxRetries } = mergedOptions;

  let lastError: RetryableError = new Error('Unknown error');

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await operation();

      if (attempt > 0) {
        logger.info({
          attempt: attempt + 1,
          total_attempts: attempt + 1
        }, 'operation succeeded after retry');
      }

      return result;
    } catch (error) {
      lastError = error as RetryableError;

      // Check if we should retry
      const shouldRetry = attempt < maxRetries && isRetryableError(lastError, mergedOptions);

      if (!shouldRetry) {
        logger.error({
          attempt: attempt + 1,
          max_retries: maxRetries,
          error: lastError.message,
          error_code: lastError.code,
          retryable: false
        }, 'operation failed - not retrying');
        throw error;
      }

      // Calculate delay for next attempt
      const delay = calculateDelay(attempt, mergedOptions);

      logger.warn({
        attempt: attempt + 1,
        max_retries: maxRetries,
        error: lastError.message,
        error_code: lastError.code,
        next_delay_ms: delay
      }, 'operation failed - scheduling retry');

      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Create a retry wrapper for a specific operation
 */
function createRetryWrapper(options: RetryOptions = {}): <T>(operation: () => Promise<T>, overrideOptions?: RetryOptions) => Promise<T> {
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };

  return <T>(operation: () => Promise<T>, overrideOptions: RetryOptions = {}): Promise<T> => {
    return withRetry(operation, { ...mergedOptions, ...overrideOptions });
  };
}

interface RetryWithIdempotencyOptions extends RetryOptions {
  cacheTtlSeconds?: number;
}

/**
 * Retry with idempotency support
 * Checks cache before operation and stores result after success
 */
async function withRetryAndIdempotency<T>(
  operation: () => Promise<T>,
  idempotencyKey: string,
  cache: RedisClientType,
  options: RetryWithIdempotencyOptions = {}
): Promise<T> {
  const { cacheTtlSeconds = 3600, ...retryOptions } = options;

  // Check if already completed
  try {
    const cached = await cache.get(`retry:${idempotencyKey}`);
    if (cached) {
      logger.info({ idempotency_key: idempotencyKey }, 'returning cached result for idempotent operation');
      return JSON.parse(cached) as T;
    }
  } catch (cacheError) {
    // Cache check failed, proceed with operation
    logger.warn({ error: (cacheError as Error).message }, 'idempotency cache check failed');
  }

  // Execute with retry
  const result = await withRetry(operation, retryOptions);

  // Cache successful result
  try {
    await cache.set(`retry:${idempotencyKey}`, JSON.stringify(result), { EX: cacheTtlSeconds });
  } catch (cacheError) {
    // Cache store failed, but operation succeeded
    logger.warn({ error: (cacheError as Error).message }, 'failed to cache idempotent result');
  }

  return result;
}

export {
  withRetry,
  createRetryWrapper,
  withRetryAndIdempotency,
  calculateDelay,
  isRetryableError,
  sleep,
  DEFAULT_OPTIONS
};
