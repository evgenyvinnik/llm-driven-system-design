import logger from './logger.js';

/**
 * Retry Utility with Exponential Backoff
 *
 * Implements retry logic for transient failures:
 * 1. Exponential backoff: wait time doubles with each retry
 * 2. Jitter: randomize wait time to prevent thundering herd
 * 3. Max retries: limit total attempts
 * 4. Configurable: different settings for different operations
 */

/**
 * Default retry configuration
 */
const DEFAULT_OPTIONS = {
  maxRetries: 3,
  baseDelayMs: 1000,     // 1 second initial delay
  maxDelayMs: 30000,     // 30 seconds max delay
  exponentialBase: 2,    // Double delay each retry
  jitterFactor: 0.2,     // 20% jitter
  retryableErrors: null, // Retry all errors by default
};

/**
 * Preset configurations for common operations
 */
export const RETRY_PRESETS = {
  // Fast retry for cache operations
  cache: {
    maxRetries: 2,
    baseDelayMs: 100,
    maxDelayMs: 1000,
  },

  // Standard retry for database operations
  database: {
    maxRetries: 3,
    baseDelayMs: 500,
    maxDelayMs: 5000,
  },

  // Patient retry for storage operations
  storage: {
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 10000,
  },

  // Very patient retry for transcoding
  transcoding: {
    maxRetries: 5,
    baseDelayMs: 5000,
    maxDelayMs: 60000,
  },

  // Aggressive retry for external services
  external: {
    maxRetries: 4,
    baseDelayMs: 2000,
    maxDelayMs: 30000,
  },
};

/**
 * Calculate delay for a retry attempt
 *
 * @param {number} attempt - Current attempt number (0-indexed)
 * @param {object} options - Retry options
 * @returns {number} Delay in milliseconds
 */
function calculateDelay(attempt, options) {
  const { baseDelayMs, maxDelayMs, exponentialBase, jitterFactor } = options;

  // Calculate exponential delay
  const exponentialDelay = baseDelayMs * Math.pow(exponentialBase, attempt);

  // Cap at max delay
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

  // Add jitter (random factor between 1-jitterFactor and 1+jitterFactor)
  const jitter = 1 + (Math.random() * 2 - 1) * jitterFactor;

  return Math.floor(cappedDelay * jitter);
}

/**
 * Sleep for specified milliseconds
 *
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if an error is retryable
 *
 * @param {Error} error - The error to check
 * @param {Array|Function|null} retryableErrors - Error check configuration
 * @returns {boolean} Whether the error is retryable
 */
function isRetryable(error, retryableErrors) {
  // If no filter specified, retry all errors
  if (retryableErrors === null) {
    return true;
  }

  // If it's a function, use it to determine
  if (typeof retryableErrors === 'function') {
    return retryableErrors(error);
  }

  // If it's an array of error codes
  if (Array.isArray(retryableErrors)) {
    return retryableErrors.includes(error.code) ||
           retryableErrors.includes(error.name);
  }

  return true;
}

/**
 * Execute a function with retry logic
 *
 * @param {Function} fn - Async function to execute
 * @param {object} options - Retry configuration
 * @returns {Promise<any>} Result of the function
 * @throws {Error} Last error if all retries fail
 *
 * @example
 * const result = await retry(
 *   async () => await fetchData(),
 *   { maxRetries: 3, baseDelayMs: 1000 }
 * );
 */
export async function retry(fn, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const { maxRetries, retryableErrors } = config;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if we should retry this error
      if (!isRetryable(error, retryableErrors)) {
        throw error;
      }

      // Check if we have retries left
      if (attempt >= maxRetries) {
        break;
      }

      // Calculate delay and wait
      const delay = calculateDelay(attempt, config);

      logger.warn({
        event: 'retry_attempt',
        attempt: attempt + 1,
        maxRetries,
        delayMs: delay,
        error: error.message,
        errorCode: error.code,
      }, `Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`);

      await sleep(delay);
    }
  }

  // All retries exhausted
  logger.error({
    event: 'retry_exhausted',
    attempts: maxRetries + 1,
    error: lastError.message,
    errorCode: lastError.code,
  }, `All ${maxRetries + 1} attempts failed`);

  throw lastError;
}

/**
 * Create a retry wrapper for a function
 *
 * @param {Function} fn - Function to wrap
 * @param {object} options - Retry configuration
 * @returns {Function} Wrapped function with retry
 *
 * @example
 * const fetchWithRetry = withRetry(fetchData, { maxRetries: 3 });
 * const result = await fetchWithRetry(arg1, arg2);
 */
export function withRetry(fn, options = {}) {
  return async (...args) => {
    return retry(() => fn(...args), options);
  };
}

/**
 * Create a retry wrapper using a preset
 *
 * @param {Function} fn - Function to wrap
 * @param {string} preset - Preset name from RETRY_PRESETS
 * @param {object} overrides - Optional overrides for the preset
 * @returns {Function} Wrapped function
 */
export function withRetryPreset(fn, preset, overrides = {}) {
  const presetConfig = RETRY_PRESETS[preset] || {};
  return withRetry(fn, { ...presetConfig, ...overrides });
}

/**
 * Retry with fallback value on failure
 *
 * @param {Function} fn - Async function to execute
 * @param {any} fallback - Fallback value if all retries fail
 * @param {object} options - Retry configuration
 * @returns {Promise<any>} Result or fallback
 */
export async function retryWithFallback(fn, fallback, options = {}) {
  try {
    return await retry(fn, options);
  } catch (error) {
    logger.warn({
      event: 'retry_fallback',
      error: error.message,
      fallbackUsed: true,
    }, 'Using fallback after retry failure');

    return typeof fallback === 'function' ? fallback() : fallback;
  }
}

/**
 * Common retryable error codes
 */
export const RETRYABLE_ERROR_CODES = [
  // Network errors
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ENETUNREACH',
  'EAI_AGAIN',

  // Database errors
  'ECONNECTION',
  '40001', // Serialization failure
  '40P01', // Deadlock
  '08006', // Connection failure

  // AWS/S3 errors
  'NetworkingError',
  'TimeoutError',
  'ServiceUnavailable',
  'SlowDown',
];

/**
 * Create a retryable error checker for common transient errors
 *
 * @returns {Function} Error checker function
 */
export function createRetryableErrorChecker() {
  return (error) => {
    // Check error code
    if (RETRYABLE_ERROR_CODES.includes(error.code)) {
      return true;
    }

    // Check HTTP status codes (5xx are usually retryable)
    if (error.statusCode >= 500 && error.statusCode < 600) {
      return true;
    }

    // Check for specific transient error messages
    const transientMessages = [
      'ECONNRESET',
      'socket hang up',
      'connection timeout',
      'network error',
      'temporarily unavailable',
    ];

    const errorMessage = error.message?.toLowerCase() || '';
    return transientMessages.some((msg) => errorMessage.includes(msg.toLowerCase()));
  };
}

export default {
  retry,
  withRetry,
  withRetryPreset,
  retryWithFallback,
  RETRY_PRESETS,
  RETRYABLE_ERROR_CODES,
  createRetryableErrorChecker,
};
