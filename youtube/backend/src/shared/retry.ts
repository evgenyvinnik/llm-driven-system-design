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

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  exponentialBase: number;
  jitterFactor: number;
  retryableErrors: string[] | ((error: Error) => boolean) | null;
}

/**
 * Default retry configuration
 */
const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000, // 1 second initial delay
  maxDelayMs: 30000, // 30 seconds max delay
  exponentialBase: 2, // Double delay each retry
  jitterFactor: 0.2, // 20% jitter
  retryableErrors: null, // Retry all errors by default
};

/**
 * Preset configurations for common operations
 */
export const RETRY_PRESETS: Record<string, Partial<RetryOptions>> = {
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
 * @param attempt - Current attempt number (0-indexed)
 * @param options - Retry options
 * @returns Delay in milliseconds
 */
function calculateDelay(attempt: number, options: RetryOptions): number {
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
 * @param ms - Milliseconds to sleep
 * @returns Promise that resolves after delay
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RetryableError extends Error {
  code?: string;
  statusCode?: number;
}

/**
 * Check if an error is retryable
 *
 * @param error - The error to check
 * @param retryableErrors - Error check configuration
 * @returns Whether the error is retryable
 */
function isRetryable(
  error: RetryableError,
  retryableErrors: string[] | ((error: Error) => boolean) | null
): boolean {
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
    return retryableErrors.includes(error.code || '') || retryableErrors.includes(error.name);
  }

  return true;
}

/**
 * Execute a function with retry logic
 *
 * @param fn - Async function to execute
 * @param options - Retry configuration
 * @returns Result of the function
 * @throws Last error if all retries fail
 *
 * @example
 * const result = await retry(
 *   async () => await fetchData(),
 *   { maxRetries: 3, baseDelayMs: 1000 }
 * );
 */
export async function retry<T>(fn: () => Promise<T>, options: Partial<RetryOptions> = {}): Promise<T> {
  const config: RetryOptions = { ...DEFAULT_OPTIONS, ...options };
  const { maxRetries, retryableErrors } = config;

  let lastError: RetryableError | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as RetryableError;

      // Check if we should retry this error
      if (!isRetryable(lastError, retryableErrors)) {
        throw error;
      }

      // Check if we have retries left
      if (attempt >= maxRetries) {
        break;
      }

      // Calculate delay and wait
      const delay = calculateDelay(attempt, config);

      logger.warn(
        {
          event: 'retry_attempt',
          attempt: attempt + 1,
          maxRetries,
          delayMs: delay,
          error: lastError.message,
          errorCode: lastError.code,
        },
        `Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`
      );

      await sleep(delay);
    }
  }

  // All retries exhausted
  logger.error(
    {
      event: 'retry_exhausted',
      attempts: maxRetries + 1,
      error: lastError?.message,
      errorCode: lastError?.code,
    },
    `All ${maxRetries + 1} attempts failed`
  );

  throw lastError;
}

/**
 * Create a retry wrapper for a function
 *
 * @param fn - Function to wrap
 * @param options - Retry configuration
 * @returns Wrapped function with retry
 *
 * @example
 * const fetchWithRetry = withRetry(fetchData, { maxRetries: 3 });
 * const result = await fetchWithRetry(arg1, arg2);
 */
export function withRetry<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  options: Partial<RetryOptions> = {}
): (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>> {
  return async (...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> => {
    return retry(() => fn(...args) as Promise<Awaited<ReturnType<T>>>, options);
  };
}

/**
 * Create a retry wrapper using a preset
 *
 * @param fn - Function to wrap
 * @param preset - Preset name from RETRY_PRESETS
 * @param overrides - Optional overrides for the preset
 * @returns Wrapped function
 */
export function withRetryPreset<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  preset: string,
  overrides: Partial<RetryOptions> = {}
): (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>> {
  const presetConfig = RETRY_PRESETS[preset] || {};
  return withRetry(fn, { ...presetConfig, ...overrides });
}

/**
 * Retry with fallback value on failure
 *
 * @param fn - Async function to execute
 * @param fallback - Fallback value if all retries fail
 * @param options - Retry configuration
 * @returns Result or fallback
 */
export async function retryWithFallback<T>(
  fn: () => Promise<T>,
  fallback: T | (() => T),
  options: Partial<RetryOptions> = {}
): Promise<T> {
  try {
    return await retry(fn, options);
  } catch (error) {
    logger.warn(
      {
        event: 'retry_fallback',
        error: (error as Error).message,
        fallbackUsed: true,
      },
      'Using fallback after retry failure'
    );

    return typeof fallback === 'function' ? (fallback as () => T)() : fallback;
  }
}

/**
 * Common retryable error codes
 */
export const RETRYABLE_ERROR_CODES: string[] = [
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
 * @returns Error checker function
 */
export function createRetryableErrorChecker(): (error: Error) => boolean {
  return (error: RetryableError): boolean => {
    // Check error code
    if (error.code && RETRYABLE_ERROR_CODES.includes(error.code)) {
      return true;
    }

    // Check HTTP status codes (5xx are usually retryable)
    if (error.statusCode && error.statusCode >= 500 && error.statusCode < 600) {
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
