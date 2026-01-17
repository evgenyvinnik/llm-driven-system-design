/**
 * Retry logic with exponential backoff for transient failures.
 * Provides resilient execution for external service calls.
 * @module shared/retry
 */

import { logger } from './logger.js';
import { retryAttemptsTotal } from './metrics.js';

/**
 * Options for retry behavior.
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay in milliseconds before first retry (default: 1000) */
  initialDelayMs?: number;
  /** Maximum delay in milliseconds (default: 30000) */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;
  /** Add random jitter to prevent thundering herd (default: true) */
  jitter?: boolean;
  /** Maximum jitter as percentage of delay (default: 0.25) */
  jitterFactor?: number;
  /** Operation name for logging and metrics */
  operationName?: string;
  /** Function to determine if error is retryable (default: all errors) */
  isRetryable?: (error: Error) => boolean;
  /** Callback called before each retry */
  onRetry?: (error: Error, attempt: number, delay: number) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'operationName' | 'onRetry' | 'isRetryable'>> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitter: true,
  jitterFactor: 0.25,
};

/**
 * Calculate delay for a given retry attempt.
 * Uses exponential backoff with optional jitter.
 * @param attempt - Current attempt number (0-based)
 * @param options - Retry options
 * @returns Delay in milliseconds
 */
function calculateDelay(attempt: number, options: Required<Omit<RetryOptions, 'operationName' | 'onRetry' | 'isRetryable'>>): number {
  // Exponential backoff: initialDelay * (multiplier ^ attempt)
  let delay = options.initialDelayMs * Math.pow(options.backoffMultiplier, attempt);

  // Cap at maximum delay
  delay = Math.min(delay, options.maxDelayMs);

  // Add jitter if enabled
  if (options.jitter) {
    const jitterRange = delay * options.jitterFactor;
    const jitter = (Math.random() - 0.5) * 2 * jitterRange;
    delay = Math.max(0, delay + jitter);
  }

  return Math.round(delay);
}

/**
 * Sleep for a specified duration.
 * @param ms - Milliseconds to sleep
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute an async function with retry logic and exponential backoff.
 * Automatically retries on failure with increasing delays.
 *
 * @param fn - The async function to execute
 * @param options - Retry configuration options
 * @returns Result of the function if successful
 * @throws Last error if all retries exhausted
 *
 * @example
 * ```typescript
 * const result = await withRetry(
 *   () => fetch('https://example.com/api'),
 *   { maxRetries: 3, operationName: 'fetch-api' }
 * );
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const operationName = options.operationName || 'unknown';
  const isRetryable = options.isRetryable || (() => true);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if this error is retryable
      if (!isRetryable(lastError)) {
        logger.warn(
          { operationName, error: lastError.message, attempt },
          'Non-retryable error, not retrying'
        );
        throw lastError;
      }

      // If this was the last attempt, throw
      if (attempt >= opts.maxRetries) {
        logger.error(
          { operationName, error: lastError.message, totalAttempts: attempt + 1 },
          'All retry attempts exhausted'
        );
        throw lastError;
      }

      // Calculate delay for next attempt
      const delay = calculateDelay(attempt, opts);

      // Log retry attempt
      logger.warn(
        { operationName, error: lastError.message, attempt: attempt + 1, nextRetryMs: delay },
        'Operation failed, retrying'
      );

      // Record metric
      retryAttemptsTotal.inc({ operation: operationName, attempt: String(attempt + 1) });

      // Call onRetry callback if provided
      if (options.onRetry) {
        options.onRetry(lastError, attempt + 1, delay);
      }

      // Wait before retry
      await sleep(delay);
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError || new Error('Retry failed');
}

/**
 * Create a retryable version of an async function.
 * Returns a new function that automatically retries on failure.
 *
 * @param fn - The async function to wrap
 * @param options - Retry configuration options
 * @returns Wrapped function with retry logic
 *
 * @example
 * ```typescript
 * const retryableFetch = createRetryable(
 *   (url: string) => fetch(url),
 *   { maxRetries: 3 }
 * );
 * const response = await retryableFetch('https://example.com');
 * ```
 */
export function createRetryable<T extends unknown[], R>(
  fn: (...args: T) => Promise<R>,
  options: RetryOptions = {}
): (...args: T) => Promise<R> {
  return (...args: T) => withRetry(() => fn(...args), options);
}

/**
 * Fetch with automatic retry on transient failures.
 * Retries on network errors and 5xx server errors.
 *
 * @param url - URL to fetch
 * @param options - Fetch options
 * @param retryOptions - Retry configuration
 * @returns Response from successful fetch
 */
export async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  retryOptions: RetryOptions = {}
): Promise<Response> {
  const defaultRetryOptions: RetryOptions = {
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    operationName: 'http-fetch',
    isRetryable: (error) => {
      // Network errors are always retryable
      if (error.message.includes('network') || error.message.includes('ECONNREFUSED')) {
        return true;
      }
      // AbortError from timeout is retryable
      if (error.name === 'AbortError') {
        return true;
      }
      return true; // Default to retryable
    },
    ...retryOptions,
  };

  return withRetry(async () => {
    const response = await fetch(url, options);

    // Retry on 5xx server errors
    if (response.status >= 500 && response.status < 600) {
      throw new Error(`Server error: HTTP ${response.status}`);
    }

    // Retry on rate limiting (429)
    if (response.status === 429) {
      throw new Error('Rate limited: HTTP 429');
    }

    // Don't retry on client errors (4xx except 429)
    if (response.status >= 400 && response.status < 500) {
      // Create a non-retryable error
      const error = new Error(`Client error: HTTP ${response.status}`);
      (error as Error & { retryable: boolean }).retryable = false;
      throw error;
    }

    return response;
  }, {
    ...defaultRetryOptions,
    isRetryable: (error) => {
      // Check if explicitly marked non-retryable
      if ((error as Error & { retryable?: boolean }).retryable === false) {
        return false;
      }
      return defaultRetryOptions.isRetryable?.(error) ?? true;
    },
  });
}

/**
 * Predefined retry strategies for common use cases.
 */
export const RetryStrategies = {
  /**
   * Fast retry for quick operations.
   * Short delays, fewer retries.
   */
  fast: {
    maxRetries: 2,
    initialDelayMs: 100,
    maxDelayMs: 1000,
    backoffMultiplier: 2,
  } as RetryOptions,

  /**
   * Standard retry for most operations.
   */
  standard: {
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 10000,
    backoffMultiplier: 2,
  } as RetryOptions,

  /**
   * Aggressive retry for critical operations.
   * More retries, longer delays.
   */
  aggressive: {
    maxRetries: 5,
    initialDelayMs: 1000,
    maxDelayMs: 60000,
    backoffMultiplier: 2,
  } as RetryOptions,

  /**
   * RSS feed fetching strategy.
   * Tailored delays matching architecture spec.
   */
  rssFeed: {
    maxRetries: 3,
    initialDelayMs: 1000, // 1s
    maxDelayMs: 30000, // 30s
    backoffMultiplier: 5, // 1s -> 5s -> 25s (capped at 30s)
    jitter: true,
    jitterFactor: 0.2,
  } as RetryOptions,
};
