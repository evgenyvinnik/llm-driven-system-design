/**
 * Retry Logic with Exponential Backoff
 *
 * WHY exponential backoff is critical for payment systems:
 *
 * 1. TRANSIENT FAILURES: Network blips, brief DB locks, and temporary
 *    service unavailability are common. Immediate retry often succeeds.
 *
 * 2. THUNDERING HERD: Without backoff, when a service recovers, all
 *    queued retries hit it simultaneously, causing another failure.
 *    Exponential delay spreads out the retry load.
 *
 * 3. JITTER: Adding randomness prevents synchronized retries from
 *    multiple clients that failed at the same time.
 *
 * 4. IDEMPOTENCY REQUIREMENT: Retries only make sense for idempotent
 *    operations. Money transfers MUST use idempotency keys to prevent
 *    duplicate charges.
 *
 * Strategy:
 * - Immediate retry for first failure (often succeeds for network blips)
 * - Exponential delay: 100ms -> 200ms -> 400ms -> 800ms...
 * - Jitter: +/- 10% randomness
 * - Max delay cap: Prevents excessive wait times
 * - Retry only on specific error types (network, timeout, rate limit)
 */

const { logger } = require('./logger');

// Retry configurations for different operation types
const RETRY_CONFIGS = {
  // Internal database operations - quick retries
  database: {
    maxRetries: 3,
    initialDelayMs: 50,
    maxDelayMs: 500,
    backoffMultiplier: 2,
    retryableErrors: [
      'ETIMEDOUT',
      'ECONNRESET',
      'ECONNREFUSED',
      'connection terminated unexpectedly',
      'deadlock detected',
      'could not serialize access',
    ],
    jitterFactor: 0.1,
  },

  // External bank API calls - longer delays
  externalPayment: {
    maxRetries: 5,
    initialDelayMs: 500,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    retryableErrors: [
      'ETIMEDOUT',
      'ECONNRESET',
      'ECONNREFUSED',
      'ENOTFOUND',
      'NETWORK_ERROR',
      'RATE_LIMITED',
      'SERVICE_UNAVAILABLE',
      '503',
      '429',
      'TEMPORARY_FAILURE',
    ],
    jitterFactor: 0.2,
  },

  // Redis cache operations - very quick retries
  cache: {
    maxRetries: 2,
    initialDelayMs: 10,
    maxDelayMs: 100,
    backoffMultiplier: 2,
    retryableErrors: ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'LOADING'],
    jitterFactor: 0.1,
  },
};

/**
 * Sleep for a specified duration with optional jitter
 * @param {number} ms - Base sleep time in milliseconds
 * @param {number} jitterFactor - Jitter factor (0.1 = +/- 10%)
 */
async function sleep(ms, jitterFactor = 0) {
  const jitter = jitterFactor > 0 ? ms * jitterFactor * (Math.random() * 2 - 1) : 0;
  const actualDelay = Math.max(0, Math.round(ms + jitter));
  return new Promise((resolve) => setTimeout(resolve, actualDelay));
}

/**
 * Check if an error is retryable based on configuration
 * @param {Error} error - The error to check
 * @param {string[]} retryableErrors - List of retryable error patterns
 */
function isRetryable(error, retryableErrors) {
  const errorString = `${error.code || ''} ${error.message || ''} ${error.status || ''}`;
  return retryableErrors.some(
    (pattern) => errorString.includes(pattern) || error.code === pattern
  );
}

/**
 * Execute an operation with retry and exponential backoff
 *
 * @param {Function} operation - Async function to execute
 * @param {Object} options - Retry configuration
 * @param {string} options.operationName - Name for logging
 * @param {string} options.configType - Config preset: 'database', 'externalPayment', 'cache'
 * @param {Object} options.context - Additional context for logging
 * @returns {Promise} Result of the operation
 */
async function retryWithBackoff(operation, options = {}) {
  const {
    operationName = 'unknown_operation',
    configType = 'database',
    context = {},
  } = options;

  // Get configuration (allow custom overrides)
  const config = { ...RETRY_CONFIGS[configType], ...options };
  const {
    maxRetries,
    initialDelayMs,
    maxDelayMs,
    backoffMultiplier,
    retryableErrors,
    jitterFactor,
  } = config;

  let lastError;
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const result = await operation();

      // Log successful retry
      if (attempt > 1) {
        logger.info({
          event: 'retry_succeeded',
          operation: operationName,
          attempt,
          totalAttempts: maxRetries + 1,
          ...context,
        });
      }

      return result;
    } catch (error) {
      lastError = error;

      // Check if error is retryable
      if (!isRetryable(error, retryableErrors)) {
        logger.debug({
          event: 'retry_not_retryable',
          operation: operationName,
          attempt,
          errorCode: error.code,
          errorMessage: error.message,
          ...context,
        });
        throw error;
      }

      // Check if we've exhausted retries
      if (attempt > maxRetries) {
        logger.error({
          event: 'retry_exhausted',
          operation: operationName,
          attempts: attempt,
          maxRetries,
          errorCode: error.code,
          errorMessage: error.message,
          ...context,
        });
        throw error;
      }

      // Log retry attempt
      logger.warn({
        event: 'retry_attempt',
        operation: operationName,
        attempt,
        maxRetries: maxRetries + 1,
        delayMs: delay,
        errorCode: error.code,
        errorMessage: error.message,
        ...context,
      });

      // Wait before retrying
      await sleep(delay, jitterFactor);

      // Calculate next delay (exponential backoff with cap)
      delay = Math.min(delay * backoffMultiplier, maxDelayMs);
    }
  }

  throw lastError;
}

/**
 * Decorator to wrap an async function with retry logic
 * @param {Object} options - Retry configuration
 */
function withRetry(options = {}) {
  return function (target, propertyKey, descriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args) {
      return retryWithBackoff(() => originalMethod.apply(this, args), {
        operationName: propertyKey,
        ...options,
      });
    };

    return descriptor;
  };
}

/**
 * Create a retryable version of an async function
 * @param {Function} fn - Async function to wrap
 * @param {Object} options - Retry configuration
 */
function makeRetryable(fn, options = {}) {
  const operationName = options.operationName || fn.name || 'anonymous';

  return async function (...args) {
    return retryWithBackoff(() => fn.apply(this, args), {
      operationName,
      ...options,
    });
  };
}

module.exports = {
  retryWithBackoff,
  withRetry,
  makeRetryable,
  sleep,
  isRetryable,
  RETRY_CONFIGS,
};
