/**
 * Circuit breaker implementation using cockatiel library.
 * Protects storage operations from cascading failures by opening
 * the circuit when too many failures occur, allowing the system to recover.
 * @module shared/circuitBreaker
 */

import {
  CircuitBreakerPolicy,
  ConsecutiveBreaker,
  circuitBreaker,
  handleAll,
  wrap,
  retry,
  ExponentialBackoff,
  IPolicy,
} from 'cockatiel';
import { logger } from './logger.js';
import {
  circuitBreakerState,
  circuitBreakerTransitions,
  circuitBreakerRejections,
  retryAttemptsTotal,
  retrySuccessTotal,
  retryExhaustedTotal,
} from './metrics.js';

/**
 * Circuit breaker states for metrics
 */
enum CircuitState {
  Closed = 0,
  Open = 1,
  HalfOpen = 2,
}

/**
 * Configuration options for creating a circuit breaker
 */
export interface CircuitBreakerOptions {
  /** Name for logging and metrics */
  name: string;
  /** Number of consecutive failures before opening circuit */
  failureThreshold?: number;
  /** Time in ms before attempting to half-open */
  halfOpenAfter?: number;
}

/**
 * Configuration options for retry policy
 */
export interface RetryOptions {
  /** Name for logging and metrics */
  name: string;
  /** Maximum number of retry attempts */
  maxAttempts?: number;
  /** Initial delay in ms for exponential backoff */
  initialDelay?: number;
  /** Maximum delay in ms between retries */
  maxDelay?: number;
  /** Exponential backoff multiplier */
  exponent?: number;
}

/**
 * Creates a circuit breaker policy for protecting external service calls.
 *
 * WHY circuit breakers protect storage services:
 * - Prevents cascading failures when MinIO is overloaded or unavailable
 * - Fails fast instead of waiting for timeouts, improving user experience
 * - Gives the storage service time to recover by reducing load
 * - Provides clear observability into storage health via state transitions
 *
 * @param options - Configuration for the circuit breaker
 * @returns Configured circuit breaker policy
 */
export function createCircuitBreaker(
  options: CircuitBreakerOptions
): CircuitBreakerPolicy {
  const {
    name,
    failureThreshold = 5,
    halfOpenAfter = 30000, // 30 seconds
  } = options;

  const breaker = circuitBreaker(handleAll, {
    breaker: new ConsecutiveBreaker(failureThreshold),
    halfOpenAfter,
  });

  // Initialize state metric
  circuitBreakerState.labels(name).set(CircuitState.Closed);

  // Log and track state changes
  breaker.onStateChange((state) => {
    const stateMap: Record<string, CircuitState> = {
      closed: CircuitState.Closed,
      open: CircuitState.Open,
      'half-open': CircuitState.HalfOpen,
    };

    const stateValue = stateMap[state] ?? CircuitState.Closed;
    circuitBreakerState.labels(name).set(stateValue);

    logger.warn({ circuitBreaker: name, state }, `Circuit breaker ${name} changed to ${state}`);
  });

  breaker.onBreak(() => {
    circuitBreakerTransitions.labels(name, 'closed', 'open').inc();
    logger.error(
      { circuitBreaker: name },
      `Circuit breaker ${name} opened - service unavailable`
    );
  });

  breaker.onReset(() => {
    circuitBreakerTransitions.labels(name, 'open', 'closed').inc();
    logger.info({ circuitBreaker: name }, `Circuit breaker ${name} reset - service recovered`);
  });

  breaker.onHalfOpen(() => {
    circuitBreakerTransitions.labels(name, 'open', 'half-open').inc();
    logger.info({ circuitBreaker: name }, `Circuit breaker ${name} half-open - testing service`);
  });

  return breaker;
}

/**
 * Creates a retry policy with exponential backoff.
 *
 * WHY retry with exponential backoff:
 * - Transient network errors and brief service blips are common
 * - Exponential backoff prevents overwhelming recovering services
 * - Jitter (built into cockatiel) prevents thundering herd problems
 * - Bounded attempts ensure requests don't hang indefinitely
 *
 * @param options - Configuration for the retry policy
 * @returns Configured retry policy
 */
export function createRetryPolicy(options: RetryOptions): IPolicy {
  const {
    name,
    maxAttempts = 3,
    initialDelay = 1000,
    maxDelay = 10000,
    exponent = 2,
  } = options;

  const retryPolicy = retry(handleAll, {
    maxAttempts,
    backoff: new ExponentialBackoff({
      initialDelay,
      maxDelay,
      exponent,
    }),
  });

  retryPolicy.onRetry((result) => {
    retryAttemptsTotal.labels(name, String(result.attempt)).inc();
    // cockatiel provides error directly on result for retry events
    const error = (result as unknown as { error?: Error }).error;
    logger.warn(
      {
        operation: name,
        attempt: result.attempt,
        delay: result.delay,
        error: error?.message,
      },
      `Retrying ${name} - attempt ${result.attempt}`
    );
  });

  retryPolicy.onSuccess((result) => {
    if (result.duration > 0) {
      retrySuccessTotal.labels(name, String(1)).inc();
    }
  });

  retryPolicy.onFailure((result) => {
    retryExhaustedTotal.labels(name).inc();
    // cockatiel provides error directly on result for failure events
    const error = (result as unknown as { error?: Error }).error;
    logger.error(
      {
        operation: name,
        error: error?.message,
      },
      `${name} failed after all retries`
    );
  });

  return retryPolicy;
}

/**
 * Combines a circuit breaker with retry policy.
 * Retry is inner (happens first), circuit breaker is outer.
 * @param breakerPolicy - Circuit breaker policy
 * @param retryPolicy - Retry policy
 * @returns Combined policy
 */
export function createResilientPolicy(
  breakerPolicy: CircuitBreakerPolicy,
  retryPolicy: IPolicy
): IPolicy {
  // Wrap: circuit breaker outer, retry inner
  // This means retries happen within the circuit breaker
  return wrap(breakerPolicy, retryPolicy);
}

// ============================================================================
// Pre-configured circuit breakers for common services
// ============================================================================

/** Circuit breaker for MinIO/S3 storage operations */
export const storageCircuitBreaker = createCircuitBreaker({
  name: 'storage',
  failureThreshold: 5,
  halfOpenAfter: 30000,
});

/** Retry policy for storage upload operations */
export const storageUploadRetryPolicy = createRetryPolicy({
  name: 'storage_upload',
  maxAttempts: 3,
  initialDelay: 1000,
  maxDelay: 8000,
  exponent: 2,
});

/** Retry policy for storage download operations */
export const storageDownloadRetryPolicy = createRetryPolicy({
  name: 'storage_download',
  maxAttempts: 3,
  initialDelay: 500,
  maxDelay: 4000,
  exponent: 2,
});

/** Combined resilient policy for uploads (retry + circuit breaker) */
export const resilientUploadPolicy = createResilientPolicy(
  storageCircuitBreaker,
  storageUploadRetryPolicy
);

/** Combined resilient policy for downloads (retry + circuit breaker) */
export const resilientDownloadPolicy = createResilientPolicy(
  storageCircuitBreaker,
  storageDownloadRetryPolicy
);

/**
 * Error thrown when circuit breaker is open
 */
export class CircuitBreakerOpenError extends Error {
  constructor(message: string = 'Service temporarily unavailable') {
    super(message);
    this.name = 'CircuitBreakerOpenError';
  }
}

/**
 * Checks if an error is a circuit breaker rejection
 */
export function isCircuitBreakerOpen(error: unknown): boolean {
  return error instanceof Error && error.message.includes('breaker is open');
}

/**
 * Wraps an async operation with circuit breaker and retry protection.
 * Use this for critical storage operations.
 *
 * @param operation - Async function to execute
 * @param policy - Policy to use (defaults to resilient upload policy)
 * @returns Result of the operation
 * @throws CircuitBreakerOpenError if circuit is open
 */
export async function withResilience<T>(
  operation: () => Promise<T>,
  policy: IPolicy = resilientUploadPolicy
): Promise<T> {
  try {
    return await policy.execute(operation);
  } catch (error) {
    if (isCircuitBreakerOpen(error)) {
      circuitBreakerRejections.labels('storage').inc();
      throw new CircuitBreakerOpenError('Storage service temporarily unavailable');
    }
    throw error;
  }
}
