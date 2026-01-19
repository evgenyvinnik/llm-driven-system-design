import { RedisClientType } from 'redis';
import { createLogger } from './logger.js';

const logger = createLogger('retry');

// Retry configuration interface
interface RetryConfig {
  maxRetries: number;
  initialDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
  jitterFactor: number;
  retryableErrors: string[];
  retryableStatusCodes: number[];
  operationName?: string;
  prefix?: string;
  idempotencyTtl?: number;
}

// Error with additional properties
interface RetryableError extends Error {
  code?: string;
  statusCode?: number;
  response?: { status: number };
  isRetryable?: boolean;
}

// Default retry configuration
const defaultConfig: RetryConfig = {
  maxRetries: 3,
  initialDelay: 1000, // 1 second
  maxDelay: 30000, // 30 seconds
  backoffMultiplier: 2, // Exponential backoff
  jitterFactor: 0.1, // 10% jitter to prevent thundering herd
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
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calculate delay with exponential backoff and jitter
 */
const calculateDelay = (attempt: number, config: RetryConfig): number => {
  const exponentialDelay = config.initialDelay * Math.pow(config.backoffMultiplier, attempt);
  const clampedDelay = Math.min(exponentialDelay, config.maxDelay);

  // Add jitter to prevent thundering herd
  const jitter = clampedDelay * config.jitterFactor * (Math.random() * 2 - 1);

  return Math.max(0, clampedDelay + jitter);
};

/**
 * Check if an error is retryable
 */
const isRetryableError = (error: RetryableError, config: RetryConfig): boolean => {
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
 * @param fn - Async function to retry
 * @param options - Retry configuration
 * @returns Result of the function
 */
export const withRetry = async <T>(
  fn: () => Promise<T>,
  options: Partial<RetryConfig> = {}
): Promise<T> => {
  const config = { ...defaultConfig, ...options };
  let lastError: RetryableError | undefined;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const result = await fn();
      if (attempt > 0) {
        logger.info(
          {
            attempt,
            operation: config.operationName || 'unknown',
          },
          'Operation succeeded after retry'
        );
      }
      return result;
    } catch (error) {
      lastError = error as RetryableError;

      // Check if we should retry
      if (attempt === config.maxRetries || !isRetryableError(lastError, config)) {
        logger.error(
          {
            attempt,
            maxRetries: config.maxRetries,
            operation: config.operationName || 'unknown',
            error: lastError.message,
            code: lastError.code,
            isRetryable: isRetryableError(lastError, config),
          },
          'Operation failed after all retries or non-retryable error'
        );
        throw error;
      }

      // Calculate delay and wait
      const delay = calculateDelay(attempt, config);
      logger.warn(
        {
          attempt,
          nextAttempt: attempt + 1,
          maxRetries: config.maxRetries,
          delayMs: delay,
          operation: config.operationName || 'unknown',
          error: lastError.message,
        },
        'Operation failed, retrying'
      );

      await sleep(delay);
    }
  }

  throw lastError;
};

/**
 * Create a retryable function wrapper
 */
export const createRetryable = <T extends unknown[], R>(
  fn: (...args: T) => Promise<R>,
  options: Partial<RetryConfig> = {}
): ((...args: T) => Promise<R>) => {
  return (...args: T) => withRetry(() => fn(...args), options);
};

/**
 * Retry with idempotency key support
 * Stores results in Redis to ensure idempotency
 */
export const withIdempotentRetry = async <T>(
  fn: () => Promise<T>,
  idempotencyKey: string,
  redis: RedisClientType,
  options: Partial<RetryConfig> = {}
): Promise<T> => {
  const config = { ...defaultConfig, ...options };
  const cacheKey = `idem:${options.prefix || 'op'}:${idempotencyKey}`;
  const ttl = options.idempotencyTtl || 86400; // 24 hours default

  // Check if already processed
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      const result = JSON.parse(cached) as T;
      logger.debug(
        {
          idempotencyKey,
          operation: config.operationName || 'unknown',
        },
        'Returning cached idempotent result'
      );
      return result;
    }
  } catch (error) {
    logger.warn(
      {
        idempotencyKey,
        error: (error as Error).message,
      },
      'Failed to check idempotency cache, proceeding with operation'
    );
  }

  // Execute with retry
  const result = await withRetry(fn, config);

  // Store result for idempotency
  try {
    await redis.setEx(cacheKey, ttl, JSON.stringify(result));
  } catch (error) {
    logger.warn(
      {
        idempotencyKey,
        error: (error as Error).message,
      },
      'Failed to store idempotency result'
    );
  }

  return result;
};

/**
 * Retry configuration presets for common operations
 */
export const retryPresets: Record<string, Partial<RetryConfig>> = {
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
