/**
 * Retry logic with exponential backoff and jitter.
 * Provides resilient operation execution with configurable retry policies.
 * Used for database operations, external service calls, and sync operations.
 */
import { logger } from './logger.js';
import { retryCounter } from './metrics.js';

/**
 * Configuration options for retry behavior.
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;
  /** Initial delay in milliseconds (default: 100) */
  initialDelayMs?: number;
  /** Maximum delay in milliseconds (default: 5000) */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;
  /** Maximum random jitter to add in milliseconds (default: 100) */
  jitterMs?: number;
  /** Function to determine if an error is retryable */
  isRetryable?: (error: unknown) => boolean;
  /** Operation name for logging and metrics */
  operationName?: string;
}

/**
 * Default retry options suitable for most operations.
 */
const defaultOptions: Required<RetryOptions> = {
  maxAttempts: 3,
  initialDelayMs: 100,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  jitterMs: 100,
  isRetryable: () => true,
  operationName: 'unknown',
};

/**
 * Calculates the delay for a given retry attempt using exponential backoff.
 * @param attempt - The current attempt number (1-based)
 * @param options - Retry options
 * @returns Delay in milliseconds
 */
function calculateDelay(attempt: number, options: Required<RetryOptions>): number {
  // Exponential backoff: initialDelay * (multiplier ^ (attempt - 1))
  const exponentialDelay = options.initialDelayMs * Math.pow(options.backoffMultiplier, attempt - 1);

  // Cap at maximum delay
  const cappedDelay = Math.min(exponentialDelay, options.maxDelayMs);

  // Add random jitter to prevent thundering herd
  const jitter = Math.random() * options.jitterMs;

  return cappedDelay + jitter;
}

/**
 * Sleeps for the specified number of milliseconds.
 * @param ms - Milliseconds to sleep
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Executes an async function with retry logic.
 * Uses exponential backoff with jitter between attempts.
 * @param fn - The async function to execute
 * @param options - Retry options
 * @returns Promise resolving to the function result
 * @throws The last error if all retries are exhausted
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts: Required<RetryOptions> = { ...defaultOptions, ...options };
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      const result = await fn();

      // Log success after retries
      if (attempt > 1) {
        logger.info({
          operation: opts.operationName,
          attempt,
          maxAttempts: opts.maxAttempts,
        }, 'Operation succeeded after retries');
      }

      return result;
    } catch (error) {
      lastError = error;

      // Check if we should retry
      const shouldRetry = opts.isRetryable(error) && attempt < opts.maxAttempts;

      // Update metrics
      retryCounter.inc({
        operation: opts.operationName,
        attempt: String(attempt),
      });

      if (shouldRetry) {
        const delay = calculateDelay(attempt, opts);

        logger.warn({
          operation: opts.operationName,
          attempt,
          maxAttempts: opts.maxAttempts,
          delayMs: Math.round(delay),
          error: error instanceof Error ? error.message : String(error),
        }, 'Operation failed, retrying');

        await sleep(delay);
      } else {
        logger.error({
          operation: opts.operationName,
          attempt,
          maxAttempts: opts.maxAttempts,
          error: error instanceof Error ? error.message : String(error),
        }, 'Operation failed, no more retries');
      }
    }
  }

  throw lastError;
}

/**
 * Preset retry options for database operations.
 * More attempts with longer delays for transient DB errors.
 */
export const dbRetryOptions: RetryOptions = {
  maxAttempts: 3,
  initialDelayMs: 100,
  maxDelayMs: 3000,
  backoffMultiplier: 2,
  jitterMs: 50,
  operationName: 'database',
  isRetryable: (error: unknown) => {
    // Retry on connection errors, deadlocks, and serialization failures
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      return (
        message.includes('connection') ||
        message.includes('deadlock') ||
        message.includes('serialization') ||
        message.includes('timeout') ||
        message.includes('econnreset') ||
        message.includes('econnrefused')
      );
    }
    return false;
  },
};

/**
 * Preset retry options for Redis operations.
 * Faster retries for the typically fast Redis operations.
 */
export const redisRetryOptions: RetryOptions = {
  maxAttempts: 3,
  initialDelayMs: 50,
  maxDelayMs: 1000,
  backoffMultiplier: 2,
  jitterMs: 25,
  operationName: 'redis',
  isRetryable: (error: unknown) => {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      return (
        message.includes('connection') ||
        message.includes('timeout') ||
        message.includes('econnreset') ||
        message.includes('econnrefused')
      );
    }
    return false;
  },
};

/**
 * Preset retry options for sync/broadcast operations.
 * Limited retries since sync failures may indicate client disconnect.
 */
export const syncRetryOptions: RetryOptions = {
  maxAttempts: 2,
  initialDelayMs: 50,
  maxDelayMs: 200,
  backoffMultiplier: 2,
  jitterMs: 25,
  operationName: 'sync',
  isRetryable: () => true,
};

/**
 * Creates a retryable version of an async function.
 * Useful for wrapping service methods with retry logic.
 * @param fn - The async function to wrap
 * @param options - Retry options
 * @returns Wrapped function that retries on failure
 */
export function makeRetryable<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  options: RetryOptions = {}
): T {
  return (async (...args: Parameters<T>) => {
    return withRetry(() => fn(...args), options);
  }) as T;
}

export default withRetry;
