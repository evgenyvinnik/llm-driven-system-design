import logger from './logger.js';

/**
 * Retry Configuration
 */
const DEFAULT_CONFIG = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 10000,
  jitterFactor: 0.2, // Add up to 20% random jitter
};

/**
 * Determine if an error is retryable
 *
 * We only retry on transient errors that might resolve on retry:
 * - Network errors (ECONNRESET, ETIMEDOUT, ECONNREFUSED)
 * - Server errors (5xx)
 * - Rate limiting (429)
 * - Database connection errors
 *
 * We do NOT retry on:
 * - Client errors (4xx except 429)
 * - Validation errors
 * - Authentication errors
 *
 * @param {Error} error - The error to check
 * @returns {boolean} Whether the error is retryable
 */
export function isRetryableError(error) {
  // Network errors
  if (error.code) {
    const retryableCodes = [
      'ECONNRESET',
      'ETIMEDOUT',
      'ECONNREFUSED',
      'EPIPE',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'EAI_AGAIN',
      'ENOTFOUND',
    ];
    if (retryableCodes.includes(error.code)) {
      return true;
    }
  }

  // HTTP status codes
  if (error.status || error.statusCode) {
    const status = error.status || error.statusCode;
    // Retry on 429 (rate limited) and 5xx (server errors)
    if (status === 429 || (status >= 500 && status < 600)) {
      return true;
    }
    // Don't retry on other 4xx errors
    if (status >= 400 && status < 500) {
      return false;
    }
  }

  // PostgreSQL connection errors
  if (error.message?.includes('connection') || error.message?.includes('timeout')) {
    return true;
  }

  // Redis errors
  if (error.message?.includes('READONLY') || error.message?.includes('CLUSTERDOWN')) {
    return true;
  }

  // Default: don't retry unknown errors
  return false;
}

/**
 * Calculate delay with exponential backoff and jitter
 *
 * Formula: min(baseDelay * 2^attempt, maxDelay) + random jitter
 *
 * @param {number} attempt - Current attempt number (1-based)
 * @param {object} config - Retry configuration
 * @returns {number} Delay in milliseconds
 */
export function calculateDelay(attempt, config = DEFAULT_CONFIG) {
  // Exponential backoff
  const exponentialDelay = config.baseDelayMs * Math.pow(2, attempt - 1);

  // Cap at max delay
  const cappedDelay = Math.min(exponentialDelay, config.maxDelayMs);

  // Add jitter to prevent thundering herd
  const jitter = cappedDelay * config.jitterFactor * Math.random();

  return Math.floor(cappedDelay + jitter);
}

/**
 * Sleep for a specified duration
 *
 * @param {number} ms - Duration in milliseconds
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute an operation with retry logic
 *
 * @param {Function} operation - Async function to execute
 * @param {object} options - Configuration options
 * @param {string} options.context - Description of the operation (for logging)
 * @param {number} options.maxAttempts - Maximum number of attempts
 * @param {number} options.baseDelayMs - Base delay between retries
 * @param {number} options.maxDelayMs - Maximum delay between retries
 * @param {Function} options.isRetryable - Custom function to determine if error is retryable
 * @param {Function} options.onRetry - Callback function called before each retry
 * @returns {Promise<any>} Result of the operation
 * @throws {Error} The last error if all retries fail
 */
export async function withRetry(operation, options = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    ...options,
  };

  const context = options.context || 'operation';
  const checkRetryable = options.isRetryable || isRetryableError;

  let lastError;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // Check if we should retry
      if (attempt === config.maxAttempts) {
        logger.error(
          {
            context,
            attempt,
            maxAttempts: config.maxAttempts,
            error: error.message,
          },
          `${context} failed after ${config.maxAttempts} attempts`,
        );
        throw error;
      }

      if (!checkRetryable(error)) {
        logger.warn(
          {
            context,
            attempt,
            error: error.message,
            retryable: false,
          },
          `${context} failed with non-retryable error`,
        );
        throw error;
      }

      // Calculate delay and wait
      const delay = calculateDelay(attempt, config);

      logger.warn(
        {
          context,
          attempt,
          maxAttempts: config.maxAttempts,
          delayMs: delay,
          error: error.message,
        },
        `${context} failed, retrying in ${delay}ms`,
      );

      // Call onRetry callback if provided
      if (options.onRetry) {
        await options.onRetry(error, attempt, delay);
      }

      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Create a retryable version of a function
 *
 * @param {Function} fn - Function to wrap
 * @param {object} options - Retry options
 * @returns {Function} Wrapped function with retry logic
 */
export function retryable(fn, options = {}) {
  return async (...args) => {
    return withRetry(() => fn(...args), options);
  };
}

/**
 * Predefined retry configurations for common use cases
 */

/**
 * Configuration for database operations
 * More attempts with longer delays for transient connection issues
 */
export const DATABASE_RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 5000,
  context: 'database_operation',
};

/**
 * Configuration for Redis operations
 * Fewer attempts with shorter delays for cache operations
 */
export const REDIS_RETRY_CONFIG = {
  maxAttempts: 2,
  baseDelayMs: 50,
  maxDelayMs: 1000,
  context: 'redis_operation',
};

/**
 * Configuration for external API calls
 * More attempts with longer delays
 */
export const EXTERNAL_API_RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 10000,
  context: 'external_api_call',
};

/**
 * Configuration for fanout operations
 * More tolerant since not user-facing
 */
export const FANOUT_RETRY_CONFIG = {
  maxAttempts: 5,
  baseDelayMs: 200,
  maxDelayMs: 15000,
  context: 'fanout_operation',
};

export default {
  withRetry,
  retryable,
  isRetryableError,
  calculateDelay,
  sleep,
  DATABASE_RETRY_CONFIG,
  REDIS_RETRY_CONFIG,
  EXTERNAL_API_RETRY_CONFIG,
  FANOUT_RETRY_CONFIG,
};
