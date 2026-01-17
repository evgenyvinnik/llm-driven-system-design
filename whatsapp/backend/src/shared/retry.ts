/**
 * Retry logic with exponential backoff for reliable message delivery.
 *
 * Implements intelligent retry strategies for transient failures,
 * ensuring messages are eventually delivered while avoiding retry storms.
 *
 * WHY retry logic with exponential backoff:
 * - Transient failures (network blips, brief overloads) are common
 * - Immediate retries would amplify load during issues
 * - Exponential backoff spreads retry load over time
 * - Jitter prevents thundering herd when many retries fire together
 * - Maximum retries prevent infinite loops for permanent failures
 *
 * Backoff formula: delay = min(baseDelay * 2^attempt + jitter, maxDelay)
 *
 * Example progression with defaults:
 * - Attempt 1: 100ms + jitter
 * - Attempt 2: 200ms + jitter
 * - Attempt 3: 400ms + jitter
 * - Attempt 4: 800ms + jitter
 * - Attempt 5: 1600ms + jitter (capped at maxDelay if exceeded)
 */

import { retryAttempts } from './metrics.js';
import { logger, LogEvents } from './logger.js';

/**
 * Configuration options for retry behavior.
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;

  /** Initial delay between retries in ms (default: 100) */
  baseDelay?: number;

  /** Maximum delay between retries in ms (default: 5000) */
  maxDelay?: number;

  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;

  /** Operation name for logging and metrics */
  operationName?: string;

  /** Function to determine if error is retryable (default: all errors) */
  isRetryable?: (error: Error) => boolean;

  /** Callback called before each retry attempt */
  onRetry?: (attempt: number, error: Error, nextDelay: number) => void;
}

/**
 * Default retry options optimized for messaging operations.
 */
const defaultOptions: Required<Omit<RetryOptions, 'onRetry' | 'isRetryable'>> = {
  maxRetries: 3,
  baseDelay: 100,
  maxDelay: 5000,
  backoffMultiplier: 2,
  operationName: 'operation',
};

/**
 * Error types that should not be retried (permanent failures).
 */
const NON_RETRYABLE_ERRORS = [
  'UNIQUE_VIOLATION', // Duplicate key (PostgreSQL)
  'NOT_FOUND', // Resource doesn't exist
  'UNAUTHORIZED', // Auth failure
  'FORBIDDEN', // Permission denied
  'VALIDATION_ERROR', // Invalid input
];

/**
 * Default function to determine if an error is retryable.
 * Non-retryable errors are returned immediately without retry.
 */
function defaultIsRetryable(error: Error & { code?: string }): boolean {
  // Check for known non-retryable error codes
  if (error.code && NON_RETRYABLE_ERRORS.includes(error.code)) {
    return false;
  }

  // Database constraint violations are not retryable
  if (error.message?.includes('violates') && error.message?.includes('constraint')) {
    return false;
  }

  // Validation errors are not retryable
  if (error.message?.includes('validation') || error.message?.includes('invalid')) {
    return false;
  }

  // Everything else is potentially retryable
  return true;
}

/**
 * Calculates delay for next retry attempt using exponential backoff with jitter.
 *
 * @param attempt - Current attempt number (1-indexed)
 * @param baseDelay - Base delay in ms
 * @param maxDelay - Maximum delay cap in ms
 * @param multiplier - Backoff multiplier
 * @returns Delay in ms before next attempt
 */
function calculateDelay(
  attempt: number,
  baseDelay: number,
  maxDelay: number,
  multiplier: number
): number {
  // Exponential backoff
  const exponentialDelay = baseDelay * Math.pow(multiplier, attempt - 1);

  // Add jitter (up to 20% of delay)
  const jitter = exponentialDelay * 0.2 * Math.random();

  // Cap at maxDelay
  return Math.min(exponentialDelay + jitter, maxDelay);
}

/**
 * Sleep for a specified duration.
 *
 * @param ms - Duration in milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes an async operation with retry logic and exponential backoff.
 *
 * @param operation - The async function to execute
 * @param options - Retry configuration options
 * @returns The result of the operation
 * @throws The last error if all retries are exhausted
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const config = {
    ...defaultOptions,
    ...options,
    isRetryable: options.isRetryable || defaultIsRetryable,
  };

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
    try {
      const result = await operation();

      // Track successful retry if not first attempt
      if (attempt > 1) {
        retryAttempts.inc({ operation: config.operationName, success: 'true' });
      }

      return result;
    } catch (error) {
      lastError = error as Error;

      // Check if we should retry
      if (attempt > config.maxRetries || !config.isRetryable(lastError)) {
        // Track failed retry
        retryAttempts.inc({ operation: config.operationName, success: 'false' });
        throw lastError;
      }

      // Calculate delay for next attempt
      const delay = calculateDelay(
        attempt,
        config.baseDelay,
        config.maxDelay,
        config.backoffMultiplier
      );

      // Log retry attempt
      logger.warn({
        event: LogEvents.RETRY_ATTEMPT,
        operation: config.operationName,
        attempt,
        maxRetries: config.maxRetries,
        nextDelay: delay,
        error: lastError.message,
      });

      // Call optional callback
      if (options.onRetry) {
        options.onRetry(attempt, lastError, delay);
      }

      // Wait before retry
      await sleep(delay);
    }
  }

  // Should never reach here, but TypeScript needs this
  throw lastError || new Error('Retry failed');
}

/**
 * Creates a retryable wrapper for message delivery operations.
 *
 * @param operation - The delivery operation to wrap
 * @param messageId - Message ID for logging
 * @param recipientId - Recipient ID for logging
 * @returns The operation result
 */
export async function retryMessageDelivery<T>(
  operation: () => Promise<T>,
  messageId: string,
  recipientId: string
): Promise<T> {
  return withRetry(operation, {
    maxRetries: 5,
    baseDelay: 200,
    maxDelay: 10000,
    operationName: 'message_delivery',
    onRetry: (attempt, error, nextDelay) => {
      logger.warn({
        event: LogEvents.DELIVERY_RETRY,
        message_id: messageId,
        recipient_id: recipientId,
        attempt,
        error: error.message,
        next_delay_ms: nextDelay,
      });
    },
  });
}

/**
 * Creates a retryable wrapper for database operations.
 *
 * @param operation - The database operation to wrap
 * @param operationName - Name for logging
 * @returns The operation result
 */
export async function retryDatabaseOperation<T>(
  operation: () => Promise<T>,
  operationName: string = 'db_operation'
): Promise<T> {
  return withRetry(operation, {
    maxRetries: 3,
    baseDelay: 50,
    maxDelay: 2000,
    operationName,
    isRetryable: (error: Error & { code?: string }) => {
      // Only retry connection/timeout errors for database
      const retryableCodes = [
        'ECONNREFUSED',
        'ETIMEDOUT',
        'ECONNRESET',
        'EPIPE',
        '57P01', // PostgreSQL admin shutdown
        '57P02', // PostgreSQL crash shutdown
        '57P03', // PostgreSQL cannot connect
      ];
      return error.code ? retryableCodes.includes(error.code) : false;
    },
  });
}

/**
 * Creates a retryable wrapper for Redis operations.
 *
 * @param operation - The Redis operation to wrap
 * @param operationName - Name for logging
 * @returns The operation result
 */
export async function retryRedisOperation<T>(
  operation: () => Promise<T>,
  operationName: string = 'redis_operation'
): Promise<T> {
  return withRetry(operation, {
    maxRetries: 3,
    baseDelay: 25,
    maxDelay: 500,
    operationName,
    isRetryable: (error: Error & { code?: string }) => {
      // Retry connection errors only
      const retryableCodes = ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE'];
      return error.code ? retryableCodes.includes(error.code) : false;
    },
  });
}
