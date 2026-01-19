/**
 * Retry Logic with Exponential Backoff
 *
 * WHY exponential backoff is critical for payment systems:
 *
 * 1. TRANSIENT FAILURES: Network blips, brief DB locks, and temporary
 *    service unavailability are common. Immediate retry often succeeds.
 *
 * 2. THUNDERING HERD: Without backoff, when a service recovers, all
 *    queued retries hit it simultaneously, causing another failure.
 *    Exponential delay spreads out the retry load.
 *
 * 3. JITTER: Adding randomness prevents synchronized retries from
 *    multiple clients that failed at the same time.
 *
 * 4. IDEMPOTENCY REQUIREMENT: Retries only make sense for idempotent
 *    operations. Money transfers MUST use idempotency keys to prevent
 *    duplicate charges.
 *
 * Strategy:
 * - Immediate retry for first failure (often succeeds for network blips)
 * - Exponential delay: 100ms -> 200ms -> 400ms -> 800ms...
 * - Jitter: +/- 10% randomness
 * - Max delay cap: Prevents excessive wait times
 * - Retry only on specific error types (network, timeout, rate limit)
 */

import { logger } from './logger.js';

export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableErrors: string[];
  jitterFactor: number;
}

export interface RetryOptions extends Partial<RetryConfig> {
  operationName?: string;
  configType?: 'database' | 'externalPayment' | 'cache';
  context?: Record<string, unknown>;
}

interface RetryableError extends Error {
  code?: string;
  status?: number;
}

// Retry configurations for different operation types
export const RETRY_CONFIGS: Record<string, RetryConfig> = {
  // Internal database operations - quick retries
  database: {
    maxRetries: 3,
    initialDelayMs: 50,
    maxDelayMs: 500,
    backoffMultiplier: 2,
    retryableErrors: [
      'ETIMEDOUT',
      'ECONNRESET',
      'ECONNREFUSED',
      'connection terminated unexpectedly',
      'deadlock detected',
      'could not serialize access',
    ],
    jitterFactor: 0.1,
  },

  // External bank API calls - longer delays
  externalPayment: {
    maxRetries: 5,
    initialDelayMs: 500,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    retryableErrors: [
      'ETIMEDOUT',
      'ECONNRESET',
      'ECONNREFUSED',
      'ENOTFOUND',
      'NETWORK_ERROR',
      'RATE_LIMITED',
      'SERVICE_UNAVAILABLE',
      '503',
      '429',
      'TEMPORARY_FAILURE',
    ],
    jitterFactor: 0.2,
  },

  // Redis cache operations - very quick retries
  cache: {
    maxRetries: 2,
    initialDelayMs: 10,
    maxDelayMs: 100,
    backoffMultiplier: 2,
    retryableErrors: ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'LOADING'],
    jitterFactor: 0.1,
  },
};

/**
 * Sleep for a specified duration with optional jitter
 */
export async function sleep(ms: number, jitterFactor: number = 0): Promise<void> {
  const jitter = jitterFactor > 0 ? ms * jitterFactor * (Math.random() * 2 - 1) : 0;
  const actualDelay = Math.max(0, Math.round(ms + jitter));
  return new Promise((resolve) => setTimeout(resolve, actualDelay));
}

/**
 * Check if an error is retryable based on configuration
 */
export function isRetryable(error: RetryableError, retryableErrors: string[]): boolean {
  const errorString = `${error.code || ''} ${error.message || ''} ${error.status || ''}`;
  return retryableErrors.some(
    (pattern) => errorString.includes(pattern) || error.code === pattern
  );
}

/**
 * Execute an operation with retry and exponential backoff
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    operationName = 'unknown_operation',
    configType = 'database',
    context = {},
  } = options;

  // Get configuration (allow custom overrides)
  const config = { ...RETRY_CONFIGS[configType], ...options };
  const {
    maxRetries,
    initialDelayMs,
    maxDelayMs,
    backoffMultiplier,
    retryableErrors,
    jitterFactor,
  } = config;

  let lastError: RetryableError | undefined;
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const result = await operation();

      // Log successful retry
      if (attempt > 1) {
        logger.info({
          event: 'retry_succeeded',
          operation: operationName,
          attempt,
          totalAttempts: maxRetries + 1,
          ...context,
        });
      }

      return result;
    } catch (error) {
      lastError = error as RetryableError;

      // Check if error is retryable
      if (!isRetryable(lastError, retryableErrors)) {
        logger.debug({
          event: 'retry_not_retryable',
          operation: operationName,
          attempt,
          errorCode: lastError.code,
          errorMessage: lastError.message,
          ...context,
        });
        throw error;
      }

      // Check if we've exhausted retries
      if (attempt > maxRetries) {
        logger.error({
          event: 'retry_exhausted',
          operation: operationName,
          attempts: attempt,
          maxRetries,
          errorCode: lastError.code,
          errorMessage: lastError.message,
          ...context,
        });
        throw error;
      }

      // Log retry attempt
      logger.warn({
        event: 'retry_attempt',
        operation: operationName,
        attempt,
        maxRetries: maxRetries + 1,
        delayMs: delay,
        errorCode: lastError.code,
        errorMessage: lastError.message,
        ...context,
      });

      // Wait before retrying
      await sleep(delay, jitterFactor);

      // Calculate next delay (exponential backoff with cap)
      delay = Math.min(delay * backoffMultiplier, maxDelayMs);
    }
  }

  throw lastError;
}

/**
 * Decorator to wrap an async function with retry logic
 */
export function withRetry(options: RetryOptions = {}) {
  return function <T>(
    _target: unknown,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ): PropertyDescriptor {
    const originalMethod = descriptor.value as (...args: unknown[]) => Promise<T>;

    descriptor.value = async function (this: unknown, ...args: unknown[]): Promise<T> {
      return retryWithBackoff(() => originalMethod.apply(this, args), {
        operationName: propertyKey,
        ...options,
      });
    };

    return descriptor;
  };
}

/**
 * Create a retryable version of an async function
 */
export function makeRetryable<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  options: RetryOptions = {}
): T {
  const operationName = options.operationName || fn.name || 'anonymous';

  return (async function (this: unknown, ...args: unknown[]) {
    return retryWithBackoff(() => fn.apply(this, args), {
      operationName,
      ...options,
    });
  }) as T;
}
