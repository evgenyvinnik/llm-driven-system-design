/**
 * Circuit breaker implementation for protecting external service calls.
 * Uses opossum for resilience patterns.
 *
 * WHY circuit breakers:
 * - Prevents cascade failures when driver matching service is overwhelmed
 * - Fails fast instead of blocking threads on failing operations
 * - Provides fallback behavior for graceful degradation
 * - Auto-recovers when the service stabilizes
 *
 * @module shared/circuitBreaker
 */
import CircuitBreaker from 'opossum';
import { matchingLogger } from './logger.js';
import { circuitBreakerState, circuitBreakerEvents } from './metrics.js';

/**
 * Default circuit breaker options.
 * Tuned for driver matching service:
 * - 5 second timeout per request
 * - Open circuit after 50% failure rate with 5+ requests
 * - Half-open after 10 seconds to test recovery
 */
export const DEFAULT_CIRCUIT_BREAKER_OPTIONS: CircuitBreaker.Options = {
  timeout: 5000, // 5 seconds
  errorThresholdPercentage: 50, // Open after 50% failures
  volumeThreshold: 5, // Minimum requests before tripping
  resetTimeout: 10000, // 10 seconds before half-open
  rollingCountTimeout: 10000, // 10 second sliding window
  rollingCountBuckets: 10,
};

/**
 * Creates a circuit breaker for a given function.
 * Automatically tracks metrics and logs state changes.
 *
 * @param name - Name of the circuit breaker (for metrics/logging)
 * @param fn - The async function to wrap
 * @param options - Circuit breaker options
 * @returns A circuit breaker instance
 */
export function createCircuitBreaker<TArgs extends unknown[], TResult>(
  name: string,
  fn: (...args: TArgs) => Promise<TResult>,
  options: Partial<CircuitBreaker.Options> = {}
): CircuitBreaker<TArgs, TResult> {
  const breaker = new CircuitBreaker<TArgs, TResult>(fn, {
    ...DEFAULT_CIRCUIT_BREAKER_OPTIONS,
    ...options,
  });

  // Set initial state metric
  circuitBreakerState.set({ name }, 0); // closed

  // Track state changes
  breaker.on('open', () => {
    matchingLogger.warn({ circuitBreaker: name }, 'Circuit breaker opened');
    circuitBreakerState.set({ name }, 1); // open
    circuitBreakerEvents.inc({ name, event: 'open' });
  });

  breaker.on('halfOpen', () => {
    matchingLogger.info({ circuitBreaker: name }, 'Circuit breaker half-open');
    circuitBreakerState.set({ name }, 0.5); // half-open
    circuitBreakerEvents.inc({ name, event: 'half-open' });
  });

  breaker.on('close', () => {
    matchingLogger.info({ circuitBreaker: name }, 'Circuit breaker closed');
    circuitBreakerState.set({ name }, 0); // closed
    circuitBreakerEvents.inc({ name, event: 'close' });
  });

  breaker.on('success', () => {
    circuitBreakerEvents.inc({ name, event: 'success' });
  });

  breaker.on('failure', (error) => {
    matchingLogger.error({ circuitBreaker: name, error: (error as Error).message }, 'Circuit breaker failure');
    circuitBreakerEvents.inc({ name, event: 'failure' });
  });

  breaker.on('timeout', () => {
    matchingLogger.warn({ circuitBreaker: name }, 'Circuit breaker timeout');
    circuitBreakerEvents.inc({ name, event: 'timeout' });
  });

  breaker.on('fallback', () => {
    circuitBreakerEvents.inc({ name, event: 'fallback' });
  });

  breaker.on('reject', () => {
    matchingLogger.warn({ circuitBreaker: name }, 'Circuit breaker rejected request (circuit open)');
    circuitBreakerEvents.inc({ name, event: 'reject' });
  });

  return breaker;
}

/**
 * Circuit breaker status information.
 */
export interface CircuitBreakerStatus {
  name: string;
  state: 'closed' | 'open' | 'halfOpen';
  stats: {
    failures: number;
    successes: number;
    fallbacks: number;
    timeouts: number;
    cacheHits: number;
  };
}

/**
 * Gets the current status of a circuit breaker.
 *
 * @param breaker - The circuit breaker instance
 * @param name - The name of the circuit breaker
 * @returns Status information
 */
export function getCircuitBreakerStatus(
  breaker: CircuitBreaker,
  name: string
): CircuitBreakerStatus {
  const stats = breaker.stats;
  return {
    name,
    state: breaker.opened ? 'open' : breaker.halfOpen ? 'halfOpen' : 'closed',
    stats: {
      failures: stats.failures,
      successes: stats.successes,
      fallbacks: stats.fallbacks,
      timeouts: stats.timeouts,
      cacheHits: stats.cacheHits,
    },
  };
}

export default {
  createCircuitBreaker,
  getCircuitBreakerStatus,
  DEFAULT_CIRCUIT_BREAKER_OPTIONS,
};
