import { createLogger } from './logger.js';
import { retryCounter } from './metrics.js';
import { Logger } from 'pino';

const log: Logger = createLogger('retry');

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitterFactor: number;
}

export interface RetryOptions extends Partial<RetryConfig> {
  isRetryable?: (error: RetryableError) => boolean;
  onRetry?: (error: Error, attempt: number, delay: number) => Promise<void>;
  context?: Record<string, unknown>;
}

export interface RetryableError extends Error {
  retryable?: boolean;
  statusCode?: number;
  code?: string;
}

/**
 * Default retry configuration
 */
const DEFAULT_CONFIG: RetryConfig = {
  maxRetries: 5,
  baseDelayMs: 1000,      // 1 second
  maxDelayMs: 300000,     // 5 minutes
  multiplier: 2,          // Exponential factor
  jitterFactor: 0.1,      // 10% jitter to prevent thundering herd
};

/**
 * Determines if an error is retryable based on common patterns
 */
export function isRetryableError(error: RetryableError): boolean {
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
 */
export function calculateBackoff(attempt: number, config: Partial<RetryConfig> = DEFAULT_CONFIG): number {
  const { baseDelayMs = 1000, maxDelayMs = 300000, multiplier = 2, jitterFactor = 0.1 } = config;

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
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute an operation with exponential backoff retry
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const config: RetryConfig = {
    ...DEFAULT_CONFIG,
    ...options,
  };

  const {
    maxRetries,
  } = config;

  const customIsRetryable = options.isRetryable;
  const onRetry = options.onRetry;
  const context = options.context || {};

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

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
        ? customIsRetryable(error as RetryableError)
        : isRetryableError(error as RetryableError);

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
        error: (error as Error).message,
      }, `Retry attempt ${attempt + 1}/${maxRetries} in ${delay}ms`);

      // Update metrics
      if ((context as { channel?: string }).channel) {
        retryCounter.labels((context as { channel: string }).channel, String(attempt + 1)).inc();
      }

      // Call retry callback if provided
      if (onRetry) {
        await onRetry(error as Error, attempt, delay);
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
 */
export function createRetryWrapper(config: Partial<RetryConfig> = {}): <T>(
  operation: () => Promise<T>,
  options?: RetryOptions
) => Promise<T> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  return function retryWrapper<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
    return withRetry(operation, { ...mergedConfig, ...options });
  };
}

/**
 * Retry configuration presets for different use cases
 */
export const RetryPresets: Record<string, Partial<RetryConfig>> = {
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
