/**
 * @fileoverview Circuit breaker implementation using opossum.
 *
 * Provides circuit breaker protection for Redis operations to prevent
 * cascading failures when Redis is unavailable. Supports configurable
 * failure thresholds, recovery timeouts, and fallback behavior.
 *
 * Circuit Breaker States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Failures exceeded threshold, requests immediately fail/fallback
 * - HALF-OPEN: Testing if service recovered, limited requests allowed
 */

import CircuitBreaker from 'opossum';
import { logger } from './logger.js';
import { prometheusMetrics } from './metrics.js';

/**
 * Configuration options for circuit breakers.
 * These can be customized per-dependency based on its characteristics.
 */
export interface CircuitBreakerOptions {
  /** Time in ms before circuit breaker trips to open state */
  timeout?: number;
  /** Error percentage threshold to trip the breaker (0-100) */
  errorThresholdPercentage?: number;
  /** Time in ms to wait before testing if service recovered */
  resetTimeout?: number;
  /** Minimum number of requests before breaker can trip */
  volumeThreshold?: number;
  /** Name for logging and metrics */
  name?: string;
}

/**
 * Default circuit breaker configuration.
 * Tuned for Redis operations which should be fast (<100ms).
 */
const DEFAULT_OPTIONS: Required<Omit<CircuitBreakerOptions, 'name'>> = {
  timeout: 3000,              // 3s operation timeout
  errorThresholdPercentage: 50, // Open after 50% failures
  resetTimeout: 10000,        // 10s before trying again
  volumeThreshold: 5,         // Minimum 5 requests before opening
};

/**
 * Create a circuit breaker for any async operation.
 * Wraps the operation with failure detection and fallback capabilities.
 *
 * @param operation - The async function to protect
 * @param options - Circuit breaker configuration
 * @returns Wrapped function with circuit breaker protection
 *
 * @example
 * ```ts
 * const protectedRedisGet = createCircuitBreaker(
 *   async (key: string) => redis.get(key),
 *   { name: 'redis-get', timeout: 1000 }
 * );
 *
 * const result = await protectedRedisGet.fire('my-key');
 * ```
 */
export function createCircuitBreaker<T extends unknown[], R>(
  operation: (...args: T) => Promise<R>,
  options: CircuitBreakerOptions = {}
): CircuitBreaker<T, R> {
  const config = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  const breaker = new CircuitBreaker<T, R>(operation, {
    timeout: config.timeout,
    errorThresholdPercentage: config.errorThresholdPercentage,
    resetTimeout: config.resetTimeout,
    volumeThreshold: config.volumeThreshold,
  });

  const name = options.name || 'unnamed';

  // Event handlers for monitoring and logging
  breaker.on('open', () => {
    logger.warn({ circuitBreaker: name }, 'Circuit breaker OPENED - failing fast');
    prometheusMetrics.circuitBreakerState.set({ name, state: 'open' }, 1);
    prometheusMetrics.circuitBreakerState.set({ name, state: 'closed' }, 0);
    prometheusMetrics.circuitBreakerState.set({ name, state: 'half_open' }, 0);
  });

  breaker.on('close', () => {
    logger.info({ circuitBreaker: name }, 'Circuit breaker CLOSED - normal operation resumed');
    prometheusMetrics.circuitBreakerState.set({ name, state: 'open' }, 0);
    prometheusMetrics.circuitBreakerState.set({ name, state: 'closed' }, 1);
    prometheusMetrics.circuitBreakerState.set({ name, state: 'half_open' }, 0);
  });

  breaker.on('halfOpen', () => {
    logger.info({ circuitBreaker: name }, 'Circuit breaker HALF-OPEN - testing recovery');
    prometheusMetrics.circuitBreakerState.set({ name, state: 'open' }, 0);
    prometheusMetrics.circuitBreakerState.set({ name, state: 'closed' }, 0);
    prometheusMetrics.circuitBreakerState.set({ name, state: 'half_open' }, 1);
  });

  breaker.on('success', () => {
    prometheusMetrics.circuitBreakerCalls.inc({ name, result: 'success' });
  });

  breaker.on('failure', (error) => {
    logger.error({ circuitBreaker: name, error: (error as Error).message }, 'Circuit breaker recorded failure');
    prometheusMetrics.circuitBreakerCalls.inc({ name, result: 'failure' });
  });

  breaker.on('timeout', () => {
    logger.warn({ circuitBreaker: name, timeoutMs: config.timeout }, 'Circuit breaker operation timed out');
    prometheusMetrics.circuitBreakerCalls.inc({ name, result: 'timeout' });
  });

  breaker.on('reject', () => {
    prometheusMetrics.circuitBreakerCalls.inc({ name, result: 'rejected' });
  });

  breaker.on('fallback', () => {
    prometheusMetrics.circuitBreakerCalls.inc({ name, result: 'fallback' });
  });

  // Initialize metrics to 0
  prometheusMetrics.circuitBreakerState.set({ name, state: 'open' }, 0);
  prometheusMetrics.circuitBreakerState.set({ name, state: 'closed' }, 1);
  prometheusMetrics.circuitBreakerState.set({ name, state: 'half_open' }, 0);

  return breaker;
}

/**
 * Circuit breaker state for health checks.
 */
export interface CircuitBreakerHealth {
  name: string;
  state: 'open' | 'closed' | 'half-open';
  stats: {
    failures: number;
    successes: number;
    rejects: number;
    timeouts: number;
    fallbacks: number;
  };
}

/**
 * Get health status from a circuit breaker.
 *
 * @param breaker - The circuit breaker to check
 * @param name - Name for the health report
 * @returns Health status object
 */
export function getCircuitBreakerHealth(
  breaker: CircuitBreaker<unknown[], unknown>,
  name: string
): CircuitBreakerHealth {
  const stats = breaker.stats;

  let state: 'open' | 'closed' | 'half-open' = 'closed';
  if (breaker.opened) {
    state = 'open';
  } else if (breaker.halfOpen) {
    state = 'half-open';
  }

  return {
    name,
    state,
    stats: {
      failures: stats.failures,
      successes: stats.successes,
      rejects: stats.rejects,
      timeouts: stats.timeouts,
      fallbacks: stats.fallbacks,
    },
  };
}
