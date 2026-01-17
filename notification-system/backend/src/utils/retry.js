import { createLogger } from './logger.js';
import { retryCounter } from './metrics.js';

const log = createLogger('retry');

/**
 * Default retry configuration
 */
const DEFAULT_CONFIG = {
  maxRetries: 5,
  baseDelayMs: 1000,      // 1 second
  maxDelayMs: 300000,     // 5 minutes
  multiplier: 2,          // Exponential factor
  jitterFactor: 0.1,      // 10% jitter to prevent thundering herd
};

/**
 * Determines if an error is retryable based on common patterns
 *
 * @param {Error} error - The error to check
 * @returns {boolean}
 */
export function isRetryableError(error) {
  // Explicitly marked as retryable
  if (error.retryable === true) {
    return true;
  }

  // Explicitly marked as non-retryable
  if (error.retryable === false) {
    return false;
  }

  // HTTP status codes that are typically retryable
  const retryableStatusCodes = [408, 429, 500, 502, 503, 504];
  if (error.statusCode && retryableStatusCodes.includes(error.statusCode)) {
    return true;
  }

  // Network errors that are typically transient
  const retryableErrorCodes = [
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'ENETUNREACH',
    'EAI_AGAIN',
  ];
  if (error.code && retryableErrorCodes.includes(error.code)) {
    return true;
  }

  // Specific error types that indicate transient issues
  const retryableMessages = [
    'socket hang up',
    'connection reset',
    'timeout',
    'temporarily unavailable',
    'service unavailable',
    'too many requests',
  ];
  const lowerMessage = (error.message || '').toLowerCase();
  if (retryableMessages.some(msg => lowerMessage.includes(msg))) {
    return true;
  }

  return false;
}

/**
 * Calculate the delay before the next retry using exponential backoff with jitter
 *
 * Formula: min(maxDelay, baseDelay * multiplier^attempt) * (1 + random jitter)
 *
 * @param {number} attempt - Current attempt number (0-indexed)
 * @param {Object} config - Retry configuration
 * @returns {number} - Delay in milliseconds
 */
export function calculateBackoff(attempt, config = DEFAULT_CONFIG) {
  const { baseDelayMs, maxDelayMs, multiplier, jitterFactor } = config;

  // Exponential delay
  const exponentialDelay = baseDelayMs * Math.pow(multiplier, attempt);

  // Cap at max delay
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

  // Add jitter to prevent thundering herd
  const jitter = cappedDelay * jitterFactor * Math.random();

  return Math.floor(cappedDelay + jitter);
}

/**
 * Sleep for a specified duration
 *
 * @param {number} ms - Duration in milliseconds
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute an operation with exponential backoff retry
 *
 * @param {Function} operation - Async operation to execute
 * @param {Object} options - Configuration options
 * @param {number} options.maxRetries - Maximum number of retry attempts
 * @param {number} options.baseDelayMs - Initial delay in milliseconds
 * @param {number} options.maxDelayMs - Maximum delay in milliseconds
 * @param {Function} options.isRetryable - Custom function to determine if error is retryable
 * @param {Function} options.onRetry - Callback called before each retry
 * @param {Object} options.context - Context object for logging
 * @returns {Promise<any>}
 */
export async function withRetry(operation, options = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    ...options,
  };

  const {
    maxRetries,
    isRetryable: customIsRetryable,
    onRetry,
    context = {},
  } = config;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // Check if this was the last attempt
      if (attempt === maxRetries) {
        log.error({
          ...context,
          attempt,
          maxRetries,
          err: error,
        }, 'All retry attempts exhausted');
        break;
      }

      // Check if error is retryable
      const shouldRetry = customIsRetryable
        ? customIsRetryable(error)
        : isRetryableError(error);

      if (!shouldRetry) {
        log.warn({
          ...context,
          attempt,
          err: error,
        }, 'Error is not retryable, giving up');
        break;
      }

      // Calculate delay
      const delay = calculateBackoff(attempt, config);

      log.info({
        ...context,
        attempt,
        maxRetries,
        delay,
        error: error.message,
      }, `Retry attempt ${attempt + 1}/${maxRetries} in ${delay}ms`);

      // Update metrics
      if (context.channel) {
        retryCounter.labels(context.channel, String(attempt + 1)).inc();
      }

      // Call retry callback if provided
      if (onRetry) {
        await onRetry(error, attempt, delay);
      }

      // Wait before retrying
      await sleep(delay);
    }
  }

  // All retries exhausted, throw the last error
  throw lastError;
}

/**
 * Create a retry wrapper with specific configuration
 *
 * @param {Object} config - Retry configuration
 * @returns {Function} - Retry wrapper function
 */
export function createRetryWrapper(config = {}) {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  return function retryWrapper(operation, options = {}) {
    return withRetry(operation, { ...mergedConfig, ...options });
  };
}

/**
 * Retry configuration presets for different use cases
 */
export const RetryPresets = {
  // Fast retry for quick operations (API calls)
  fast: {
    maxRetries: 3,
    baseDelayMs: 100,
    maxDelayMs: 2000,
    multiplier: 2,
  },

  // Standard retry for most operations
  standard: {
    maxRetries: 5,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    multiplier: 2,
  },

  // Slow retry for long-running operations
  slow: {
    maxRetries: 10,
    baseDelayMs: 5000,
    maxDelayMs: 300000,
    multiplier: 2,
  },

  // Aggressive retry for critical operations
  aggressive: {
    maxRetries: 15,
    baseDelayMs: 500,
    maxDelayMs: 60000,
    multiplier: 1.5,
  },
};

/**
 * Retry schedule table for documentation
 *
 * Standard preset (default):
 * | Attempt | Delay | Cumulative |
 * |---------|-------|------------|
 * | 1       | ~1s   | ~1s        |
 * | 2       | ~2s   | ~3s        |
 * | 3       | ~4s   | ~7s        |
 * | 4       | ~8s   | ~15s       |
 * | 5       | ~16s  | ~31s       |
 */

export default {
  withRetry,
  isRetryableError,
  calculateBackoff,
  sleep,
  createRetryWrapper,
  RetryPresets,
};
