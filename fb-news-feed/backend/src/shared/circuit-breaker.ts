/**
 * @fileoverview Circuit breaker implementation using opossum.
 * Protects against cascade failures by failing fast when downstream services are unhealthy.
 * Implements the circuit breaker pattern with configurable thresholds.
 */

import CircuitBreaker from 'opossum';
import { logger } from './logger.js';
import { circuitBreakerState, circuitBreakerStateChanges } from './metrics.js';

/**
 * Default circuit breaker options.
 * These values are tuned for local development but can be overridden per-breaker.
 */
const DEFAULT_OPTIONS: CircuitBreaker.Options = {
  timeout: 3000, // If function takes longer than 3 seconds, trigger a failure
  errorThresholdPercentage: 50, // When 50% of requests fail, open the circuit
  resetTimeout: 30000, // After 30 seconds, try again (half-open state)
  volumeThreshold: 5, // Minimum number of requests before tripping the circuit
  rollingCountTimeout: 10000, // Rolling window of 10 seconds for failure rate
  rollingCountBuckets: 10, // Number of buckets in the rolling window
};

/**
 * State mapping for metrics.
 * Maps circuit breaker states to numeric values for Prometheus gauges.
 */
const STATE_VALUES = {
  closed: 0,
  halfOpen: 1,
  open: 2,
};

/**
 * Creates a circuit breaker for an async function with monitoring.
 * Automatically tracks state changes and emits metrics.
 *
 * @param fn - The async function to wrap with circuit breaker protection
 * @param name - Name of the circuit breaker (used for logging and metrics)
 * @param options - Optional overrides for circuit breaker configuration
 * @returns Circuit breaker instance wrapping the function
 */
export function createCircuitBreaker<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  name: string,
  options?: Partial<CircuitBreaker.Options>
): CircuitBreaker<TArgs, TResult> {
  const breaker = new CircuitBreaker(fn, {
    ...DEFAULT_OPTIONS,
    ...options,
    name,
  }) as CircuitBreaker<TArgs, TResult>;

  // Set initial state metric
  circuitBreakerState.labels(name).set(STATE_VALUES.closed);

  // Log and record state transitions
  breaker.on('open', () => {
    logger.warn({ circuitBreaker: name }, 'Circuit breaker OPENED - failing fast');
    circuitBreakerState.labels(name).set(STATE_VALUES.open);
    circuitBreakerStateChanges.labels(name, 'closed', 'open').inc();
  });

  breaker.on('halfOpen', () => {
    logger.info({ circuitBreaker: name }, 'Circuit breaker HALF-OPEN - testing');
    circuitBreakerState.labels(name).set(STATE_VALUES.halfOpen);
    circuitBreakerStateChanges.labels(name, 'open', 'halfOpen').inc();
  });

  breaker.on('close', () => {
    logger.info({ circuitBreaker: name }, 'Circuit breaker CLOSED - normal operation');
    circuitBreakerState.labels(name).set(STATE_VALUES.closed);
    circuitBreakerStateChanges.labels(name, 'halfOpen', 'closed').inc();
  });

  breaker.on('timeout', () => {
    logger.warn({ circuitBreaker: name }, 'Circuit breaker timeout');
  });

  breaker.on('reject', () => {
    logger.warn({ circuitBreaker: name }, 'Circuit breaker rejected request (circuit open)');
  });

  breaker.on('fallback', (result) => {
    logger.info({ circuitBreaker: name, fallbackResult: result }, 'Circuit breaker using fallback');
  });

  return breaker;
}

/**
 * Circuit breaker configuration presets for different use cases.
 */
export const BREAKER_PRESETS = {
  /**
   * For fast operations that should fail quickly (e.g., cache lookups).
   */
  fast: {
    timeout: 1000,
    errorThresholdPercentage: 50,
    resetTimeout: 10000,
    volumeThreshold: 10,
  } as Partial<CircuitBreaker.Options>,

  /**
   * For slower operations that need more time (e.g., complex queries).
   */
  slow: {
    timeout: 10000,
    errorThresholdPercentage: 25,
    resetTimeout: 60000,
    volumeThreshold: 3,
  } as Partial<CircuitBreaker.Options>,

  /**
   * For critical operations where we want to be more conservative.
   */
  critical: {
    timeout: 5000,
    errorThresholdPercentage: 25,
    resetTimeout: 30000,
    volumeThreshold: 3,
  } as Partial<CircuitBreaker.Options>,
};

/**
 * Utility to get circuit breaker statistics for health checks.
 *
 * @param breaker - The circuit breaker to get stats from
 * @returns Object with circuit breaker statistics
 */
export function getCircuitBreakerStats(breaker: CircuitBreaker) {
  const stats = breaker.stats;
  return {
    name: breaker.name,
    state: breaker.status.toString(),
    failures: stats.failures,
    successes: stats.successes,
    rejects: stats.rejects,
    timeouts: stats.timeouts,
    fallbacks: stats.fallbacks,
  };
}
