/**
 * Retry Utility with Exponential Backoff.
 *
 * Provides resilient retry logic for transient failures.
 * Uses exponential backoff with jitter to prevent thundering herd problems.
 *
 * Key Features:
 * - Configurable retry count and delays
 * - Exponential backoff with optional jitter
 * - Retryable error classification
 * - Idempotency key support for safe retries
 */
import { logger } from './logger.js';

/**
 * Configuration options for retry behavior.
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay in milliseconds before first retry (default: 100) */
  baseDelayMs?: number;
  /** Maximum delay cap in milliseconds (default: 5000) */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff (default: 2) */
  multiplier?: number;
  /** Whether to add random jitter to delays (default: true) */
  jitter?: boolean;
  /** Error codes that should trigger a retry */
  retryableErrorCodes?: string[];
  /** HTTP status codes that should trigger a retry */
  retryableStatusCodes?: number[];
  /** Custom function to determine if error is retryable */
  isRetryable?: (error: unknown) => boolean;
  /** Operation name for logging */
  operationName?: string;
}

/**
 * Default retry options.
 */
const DEFAULT_RETRY_OPTIONS: Required<Omit<RetryOptions, 'isRetryable' | 'operationName'>> & {
  isRetryable: undefined;
  operationName: undefined;
} = {
  maxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 5000,
  multiplier: 2,
  jitter: true,
  retryableErrorCodes: ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'],
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
  isRetryable: undefined,
  operationName: undefined,
};

/**
 * Error class for retry exhaustion.
 */
export class RetryExhaustedError extends Error {
  public readonly attempts: number;
  public readonly lastError: unknown;

  constructor(message: string, attempts: number, lastError: unknown) {
    super(message);
    this.name = 'RetryExhaustedError';
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

/**
 * Sleeps for a specified duration.
 *
 * @param ms - Milliseconds to sleep
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculates delay for a given attempt with optional jitter.
 *
 * @param attempt - Current attempt number (0-indexed)
 * @param options - Retry options
 * @returns Delay in milliseconds
 */
function calculateDelay(attempt: number, options: Required<RetryOptions>): number {
  // Exponential backoff: baseDelay * multiplier^attempt
  let delay = options.baseDelayMs * Math.pow(options.multiplier, attempt);

  // Add jitter (0-100ms) to prevent thundering herd
  if (options.jitter) {
    delay += Math.random() * 100;
  }

  // Cap at maximum delay
  return Math.min(delay, options.maxDelayMs);
}

/**
 * Determines if an error should trigger a retry.
 *
 * @param error - The error to check
 * @param options - Retry options
 * @returns True if the error is retryable
 */
function isErrorRetryable(error: unknown, options: RetryOptions): boolean {
  // Use custom retry function if provided
  if (options.isRetryable) {
    return options.isRetryable(error);
  }

  const retryableErrorCodes = options.retryableErrorCodes || DEFAULT_RETRY_OPTIONS.retryableErrorCodes;
  const retryableStatusCodes = options.retryableStatusCodes || DEFAULT_RETRY_OPTIONS.retryableStatusCodes;

  // Check for error code
  if (error && typeof error === 'object') {
    const errorWithCode = error as { code?: string; status?: number; statusCode?: number };

    if (errorWithCode.code && retryableErrorCodes.includes(errorWithCode.code)) {
      return true;
    }

    // Check for HTTP status code
    const statusCode = errorWithCode.status || errorWithCode.statusCode;
    if (statusCode && retryableStatusCodes.includes(statusCode)) {
      return true;
    }
  }

  // Check for generic errors that might be transient
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('timeout') ||
      message.includes('connection') ||
      message.includes('network') ||
      message.includes('econnrefused') ||
      message.includes('temporarily unavailable')
    );
  }

  return false;
}

/**
 * Executes an operation with retry logic and exponential backoff.
 *
 * @param operation - Async function to execute
 * @param options - Retry configuration options
 * @returns Promise resolving to the operation result
 * @throws RetryExhaustedError if all retries fail
 *
 * @example
 * const result = await retryWithBackoff(
 *   () => fetchFromExternalAPI(url),
 *   {
 *     maxRetries: 3,
 *     baseDelayMs: 200,
 *     operationName: 'fetchExternalAPI'
 *   }
 * );
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const mergedOptions: Required<RetryOptions> = {
    ...DEFAULT_RETRY_OPTIONS,
    ...options,
  } as Required<RetryOptions>;

  let lastError: unknown;

  for (let attempt = 0; attempt <= mergedOptions.maxRetries; attempt++) {
    try {
      const result = await operation();
      return result;
    } catch (error) {
      lastError = error;

      // Check if we should retry
      const shouldRetry = attempt < mergedOptions.maxRetries && isErrorRetryable(error, mergedOptions);

      if (!shouldRetry) {
        throw error;
      }

      // Calculate delay
      const delay = calculateDelay(attempt, mergedOptions);

      logger.warn({
        operation: mergedOptions.operationName || 'unknown',
        attempt: attempt + 1,
        maxRetries: mergedOptions.maxRetries,
        delayMs: Math.round(delay),
        error: error instanceof Error ? error.message : String(error),
      }, `Retrying operation after failure`);

      await sleep(delay);
    }
  }

  throw new RetryExhaustedError(
    `Operation failed after ${mergedOptions.maxRetries + 1} attempts`,
    mergedOptions.maxRetries + 1,
    lastError
  );
}

/**
 * Creates a retryable version of an async function.
 *
 * @param fn - Async function to wrap
 * @param options - Retry configuration options
 * @returns Wrapped function with retry behavior
 *
 * @example
 * const fetchWithRetry = withRetry(
 *   (url: string) => fetch(url),
 *   { maxRetries: 3 }
 * );
 * const result = await fetchWithRetry('https://api.example.com');
 */
export function withRetry<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: RetryOptions = {}
): (...args: TArgs) => Promise<TResult> {
  return (...args: TArgs) => retryWithBackoff(() => fn(...args), options);
}

// =========================================================
// Idempotency Support
// =========================================================

/**
 * Idempotency key cache entry.
 */
interface IdempotencyCacheEntry<T> {
  result: T;
  timestamp: number;
  expiresAt: number;
}

/**
 * In-memory idempotency cache.
 * In production, use Redis for distributed idempotency.
 */
const idempotencyCache = new Map<string, IdempotencyCacheEntry<unknown>>();

/**
 * Options for idempotent operations.
 */
export interface IdempotentOptions extends RetryOptions {
  /** Idempotency key (should be unique per operation) */
  idempotencyKey: string;
  /** TTL for cached response in milliseconds (default: 24 hours) */
  cacheTtlMs?: number;
}

/**
 * Executes an operation with idempotency support.
 * If the same idempotency key was used before, returns the cached result.
 *
 * @param operation - Async function to execute
 * @param options - Idempotency and retry options
 * @returns Promise resolving to the operation result
 *
 * @example
 * const result = await retryWithIdempotency(
 *   () => createPayment(userId, amount),
 *   {
 *     idempotencyKey: `payment:${userId}:${requestId}`,
 *     maxRetries: 3
 *   }
 * );
 */
export async function retryWithIdempotency<T>(
  operation: () => Promise<T>,
  options: IdempotentOptions
): Promise<T> {
  const { idempotencyKey, cacheTtlMs = 24 * 60 * 60 * 1000, ...retryOptions } = options;

  // Check cache
  const cached = idempotencyCache.get(idempotencyKey);
  if (cached && cached.expiresAt > Date.now()) {
    logger.debug({ idempotencyKey }, 'Returning cached idempotent result');
    return cached.result as T;
  }

  // Execute with retry
  const result = await retryWithBackoff(operation, retryOptions);

  // Cache result
  idempotencyCache.set(idempotencyKey, {
    result,
    timestamp: Date.now(),
    expiresAt: Date.now() + cacheTtlMs,
  });

  // Clean up expired entries periodically
  if (Math.random() < 0.01) {
    cleanupIdempotencyCache();
  }

  return result;
}

/**
 * Cleans up expired idempotency cache entries.
 */
function cleanupIdempotencyCache(): void {
  const now = Date.now();
  for (const [key, entry] of idempotencyCache) {
    if (entry.expiresAt < now) {
      idempotencyCache.delete(key);
    }
  }
}

/**
 * Clears the idempotency cache (useful for testing).
 */
export function clearIdempotencyCache(): void {
  idempotencyCache.clear();
}

/**
 * Gets the size of the idempotency cache.
 */
export function getIdempotencyCacheSize(): number {
  return idempotencyCache.size;
}
