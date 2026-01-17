/**
 * Retry utilities with exponential backoff for resilient operations.
 * Provides configurable retry logic for transient failures in external services.
 *
 * WHY: Network calls, database operations, and external services can fail temporarily
 * due to network hiccups, resource contention, or brief outages. Retrying with
 * exponential backoff gives the system time to recover while avoiding overwhelming
 * an already struggling service.
 *
 * @module shared/retry
 */

import { logger } from './logger.js'

/**
 * Configuration options for retry operations.
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (not including the initial attempt) */
  maxRetries: number
  /** Initial delay in milliseconds before the first retry */
  initialDelayMs: number
  /** Maximum delay in milliseconds between retries */
  maxDelayMs: number
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier: number
  /** Optional jitter factor (0-1) to randomize delays and prevent thundering herd */
  jitter: number
  /** Optional function to determine if an error is retryable */
  isRetryable?: (error: unknown) => boolean
  /** Optional label for logging purposes */
  operationName?: string
}

/**
 * Default retry options.
 * Conservative settings suitable for most operations.
 */
const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  initialDelayMs: 100,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  jitter: 0.1,
}

/**
 * Result of a retry operation including metadata.
 */
export interface RetryResult<T> {
  /** The successful result value */
  result: T
  /** Number of attempts made (1 = no retries needed) */
  attempts: number
  /** Total time spent including delays */
  totalTimeMs: number
}

/**
 * Executes a function with retry logic and exponential backoff.
 * Automatically retries on failure with increasing delays between attempts.
 *
 * @param fn - Async function to execute
 * @param options - Retry configuration options
 * @returns Promise resolving to the function's result with metadata
 * @throws The last error if all retries are exhausted
 *
 * @example
 * ```typescript
 * const result = await withRetry(
 *   () => minio.putObject(bucket, key, data),
 *   { maxRetries: 4, initialDelayMs: 100, operationName: 'minio-upload' }
 * )
 * console.log(`Completed in ${result.attempts} attempt(s)`)
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<RetryResult<T>> {
  const config: RetryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options }
  const startTime = Date.now()
  let lastError: unknown = null
  let attempt = 0

  while (attempt <= config.maxRetries) {
    attempt++

    try {
      const result = await fn()
      const totalTimeMs = Date.now() - startTime

      if (attempt > 1) {
        logger.info({
          msg: 'Retry succeeded',
          operation: config.operationName || 'unknown',
          attempt,
          totalTimeMs,
        })
      }

      return { result, attempts: attempt, totalTimeMs }
    } catch (error) {
      lastError = error

      // Check if error is retryable
      if (config.isRetryable && !config.isRetryable(error)) {
        throw error
      }

      // Check if we have retries left
      if (attempt > config.maxRetries) {
        break
      }

      // Calculate delay with exponential backoff and jitter
      const baseDelay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt - 1)
      const jitteredDelay = baseDelay * (1 + config.jitter * (Math.random() * 2 - 1))
      const delay = Math.min(jitteredDelay, config.maxDelayMs)

      logger.warn({
        msg: 'Operation failed, retrying',
        operation: config.operationName || 'unknown',
        attempt,
        maxRetries: config.maxRetries,
        nextRetryMs: Math.round(delay),
        error: error instanceof Error ? error.message : String(error),
      })

      await sleep(delay)
    }
  }

  // All retries exhausted
  logger.error({
    msg: 'All retries exhausted',
    operation: config.operationName || 'unknown',
    attempts: attempt,
    totalTimeMs: Date.now() - startTime,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  })

  throw lastError
}

/**
 * Sleep for a specified duration.
 * @param ms - Duration in milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Pre-configured retry options for common service types.
 */
export const RetryPresets = {
  /**
   * Retry configuration for MinIO object storage.
   * More retries with longer delays for large file operations.
   */
  minio: {
    maxRetries: 4,
    initialDelayMs: 100,
    maxDelayMs: 2000,
    backoffMultiplier: 2,
    jitter: 0.1,
    operationName: 'minio',
  } as Partial<RetryOptions>,

  /**
   * Retry configuration for PostgreSQL database.
   * Fewer retries with shorter delays for transient connection issues.
   */
  postgres: {
    maxRetries: 3,
    initialDelayMs: 50,
    maxDelayMs: 500,
    backoffMultiplier: 2,
    jitter: 0.1,
    operationName: 'postgres',
    isRetryable: (error: unknown) => {
      // Only retry connection and timeout errors, not query errors
      if (error instanceof Error) {
        const retryablePatterns = [
          'ECONNREFUSED',
          'ETIMEDOUT',
          'ECONNRESET',
          'connection terminated',
          'Connection terminated',
          'too many clients',
        ]
        return retryablePatterns.some((pattern) => error.message.includes(pattern))
      }
      return false
    },
  } as Partial<RetryOptions>,

  /**
   * Retry configuration for RabbitMQ message publishing.
   * Longer delays since queue processing is async anyway.
   */
  rabbitmq: {
    maxRetries: 5,
    initialDelayMs: 500,
    maxDelayMs: 5000,
    backoffMultiplier: 2,
    jitter: 0.2,
    operationName: 'rabbitmq',
  } as Partial<RetryOptions>,

  /**
   * Fast retry for cache operations (Redis).
   * Quick retries since cache misses are acceptable.
   */
  cache: {
    maxRetries: 2,
    initialDelayMs: 25,
    maxDelayMs: 100,
    backoffMultiplier: 2,
    jitter: 0.1,
    operationName: 'cache',
  } as Partial<RetryOptions>,
}

/**
 * Wraps a function to always retry with the specified options.
 * Returns a new function with built-in retry behavior.
 *
 * @param fn - Function to wrap
 * @param options - Retry configuration options
 * @returns Wrapped function with retry behavior
 *
 * @example
 * ```typescript
 * const reliableUpload = withRetryWrapper(
 *   (data: Buffer) => minio.putObject('bucket', 'key', data),
 *   RetryPresets.minio
 * )
 *
 * // Later, just call the wrapped function
 * await reliableUpload(myData)
 * ```
 */
export function withRetryWrapper<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: Partial<RetryOptions> = {}
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs): Promise<TResult> => {
    const result = await withRetry(() => fn(...args), options)
    return result.result
  }
}
