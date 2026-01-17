import { createLogger } from './logger.js';

const logger = createLogger('retry');

// Default retry configuration
const defaultConfig = {
  maxRetries: 3,
  initialDelay: 1000,       // 1 second
  maxDelay: 30000,          // 30 seconds
  backoffMultiplier: 2,     // Exponential backoff
  jitterFactor: 0.1,        // 10% jitter to prevent thundering herd
  retryableErrors: [
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'EPIPE',
    'EHOSTUNREACH',
    'EAI_AGAIN',
    'ENOTFOUND',
  ],
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
};

/**
 * Sleep for a specified duration
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Calculate delay with exponential backoff and jitter
 */
const calculateDelay = (attempt, config) => {
  const exponentialDelay = config.initialDelay * Math.pow(config.backoffMultiplier, attempt);
  const clampedDelay = Math.min(exponentialDelay, config.maxDelay);

  // Add jitter to prevent thundering herd
  const jitter = clampedDelay * config.jitterFactor * (Math.random() * 2 - 1);

  return Math.max(0, clampedDelay + jitter);
};

/**
 * Check if an error is retryable
 */
const isRetryableError = (error, config) => {
  // Check error code
  if (error.code && config.retryableErrors.includes(error.code)) {
    return true;
  }

  // Check HTTP status code
  if (error.statusCode && config.retryableStatusCodes.includes(error.statusCode)) {
    return true;
  }

  // Check response status
  if (error.response?.status && config.retryableStatusCodes.includes(error.response.status)) {
    return true;
  }

  // Custom retry check
  if (error.isRetryable === true) {
    return true;
  }

  return false;
};

/**
 * Retry an async operation with exponential backoff
 *
 * @param {Function} fn - Async function to retry
 * @param {Object} options - Retry configuration
 * @returns {Promise} - Result of the function
 */
export const withRetry = async (fn, options = {}) => {
  const config = { ...defaultConfig, ...options };
  let lastError;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const result = await fn();
      if (attempt > 0) {
        logger.info({
          attempt,
          operation: config.operationName || 'unknown',
        }, 'Operation succeeded after retry');
      }
      return result;
    } catch (error) {
      lastError = error;

      // Check if we should retry
      if (attempt === config.maxRetries || !isRetryableError(error, config)) {
        logger.error({
          attempt,
          maxRetries: config.maxRetries,
          operation: config.operationName || 'unknown',
          error: error.message,
          code: error.code,
          isRetryable: isRetryableError(error, config),
        }, 'Operation failed after all retries or non-retryable error');
        throw error;
      }

      // Calculate delay and wait
      const delay = calculateDelay(attempt, config);
      logger.warn({
        attempt,
        nextAttempt: attempt + 1,
        maxRetries: config.maxRetries,
        delayMs: delay,
        operation: config.operationName || 'unknown',
        error: error.message,
      }, 'Operation failed, retrying');

      await sleep(delay);
    }
  }

  throw lastError;
};

/**
 * Create a retryable function wrapper
 */
export const createRetryable = (fn, options = {}) => {
  return (...args) => withRetry(() => fn(...args), options);
};

/**
 * Retry with idempotency key support
 * Stores results in Redis to ensure idempotency
 */
export const withIdempotentRetry = async (fn, idempotencyKey, redis, options = {}) => {
  const config = { ...defaultConfig, ...options };
  const cacheKey = `idem:${options.prefix || 'op'}:${idempotencyKey}`;
  const ttl = options.idempotencyTtl || 86400; // 24 hours default

  // Check if already processed
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      const result = JSON.parse(cached);
      logger.debug({
        idempotencyKey,
        operation: config.operationName || 'unknown',
      }, 'Returning cached idempotent result');
      return result;
    }
  } catch (error) {
    logger.warn({
      idempotencyKey,
      error: error.message,
    }, 'Failed to check idempotency cache, proceeding with operation');
  }

  // Execute with retry
  const result = await withRetry(fn, config);

  // Store result for idempotency
  try {
    await redis.setEx(cacheKey, ttl, JSON.stringify(result));
  } catch (error) {
    logger.warn({
      idempotencyKey,
      error: error.message,
    }, 'Failed to store idempotency result');
  }

  return result;
};

/**
 * Retry configuration presets for common operations
 */
export const retryPresets = {
  // For database operations - quick retries
  database: {
    maxRetries: 3,
    initialDelay: 100,
    maxDelay: 2000,
    backoffMultiplier: 2,
    operationName: 'database',
  },

  // For external API calls - more patient
  externalApi: {
    maxRetries: 5,
    initialDelay: 500,
    maxDelay: 30000,
    backoffMultiplier: 2,
    operationName: 'external-api',
  },

  // For video processing - very patient
  videoProcessing: {
    maxRetries: 3,
    initialDelay: 5000,
    maxDelay: 60000,
    backoffMultiplier: 2,
    operationName: 'video-processing',
  },

  // For Redis operations - quick retries
  redis: {
    maxRetries: 2,
    initialDelay: 50,
    maxDelay: 500,
    backoffMultiplier: 2,
    operationName: 'redis',
  },

  // For S3/MinIO operations
  storage: {
    maxRetries: 3,
    initialDelay: 500,
    maxDelay: 10000,
    backoffMultiplier: 2,
    operationName: 'storage',
  },
};

export default {
  withRetry,
  createRetryable,
  withIdempotentRetry,
  retryPresets,
};
