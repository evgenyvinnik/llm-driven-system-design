/**
 * Retry Logic with Exponential Backoff
 *
 * Provides resilient execution of operations with:
 * - Exponential backoff with jitter
 * - Configurable retry conditions
 * - Integration with idempotency keys
 * - Detailed logging of retry attempts
 */
const { logger } = require('./logger');

// Default retry configuration
const DEFAULT_OPTIONS = {
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
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate delay with exponential backoff and jitter
 * @param {number} attempt - Current attempt number (0-indexed)
 * @param {Object} options - Retry options
 * @returns {number} Delay in milliseconds
 */
function calculateDelay(attempt, options) {
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
 * @param {Error} error - The error to check
 * @param {Object} options - Retry options
 * @returns {boolean}
 */
function isRetryableError(error, options) {
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
 *
 * @param {Function} operation - Async function to execute
 * @param {Object} options - Retry options
 * @returns {Promise<any>} Result of the operation
 * @throws {Error} Last error if all retries fail
 */
async function withRetry(operation, options = {}) {
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };
  const { maxRetries } = mergedOptions;

  let lastError;

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
      lastError = error;

      // Check if we should retry
      const shouldRetry = attempt < maxRetries && isRetryableError(error, mergedOptions);

      if (!shouldRetry) {
        logger.error({
          attempt: attempt + 1,
          max_retries: maxRetries,
          error: error.message,
          error_code: error.code,
          retryable: false
        }, 'operation failed - not retrying');
        throw error;
      }

      // Calculate delay for next attempt
      const delay = calculateDelay(attempt, mergedOptions);

      logger.warn({
        attempt: attempt + 1,
        max_retries: maxRetries,
        error: error.message,
        error_code: error.code,
        next_delay_ms: delay
      }, 'operation failed - scheduling retry');

      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Create a retry wrapper for a specific operation
 *
 * @param {Object} options - Default options for this wrapper
 * @returns {Function} A function that wraps operations with retry logic
 */
function createRetryWrapper(options = {}) {
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };

  return (operation, overrideOptions = {}) => {
    return withRetry(operation, { ...mergedOptions, ...overrideOptions });
  };
}

/**
 * Retry with idempotency support
 * Checks cache before operation and stores result after success
 *
 * @param {Function} operation - Async function to execute
 * @param {string} idempotencyKey - Unique key for this operation
 * @param {Object} cache - Cache object with get/set methods (e.g., Redis client)
 * @param {Object} options - Retry options plus cacheTtlSeconds
 * @returns {Promise<any>} Result of the operation
 */
async function withRetryAndIdempotency(operation, idempotencyKey, cache, options = {}) {
  const { cacheTtlSeconds = 3600, ...retryOptions } = options;

  // Check if already completed
  try {
    const cached = await cache.get(`retry:${idempotencyKey}`);
    if (cached) {
      logger.info({ idempotency_key: idempotencyKey }, 'returning cached result for idempotent operation');
      return JSON.parse(cached);
    }
  } catch (cacheError) {
    // Cache check failed, proceed with operation
    logger.warn({ error: cacheError.message }, 'idempotency cache check failed');
  }

  // Execute with retry
  const result = await withRetry(operation, retryOptions);

  // Cache successful result
  try {
    await cache.set(`retry:${idempotencyKey}`, JSON.stringify(result), { EX: cacheTtlSeconds });
  } catch (cacheError) {
    // Cache store failed, but operation succeeded
    logger.warn({ error: cacheError.message }, 'failed to cache idempotent result');
  }

  return result;
}

module.exports = {
  withRetry,
  createRetryWrapper,
  withRetryAndIdempotency,
  calculateDelay,
  isRetryableError,
  sleep,
  DEFAULT_OPTIONS
};
