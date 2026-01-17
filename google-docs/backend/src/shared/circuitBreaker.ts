/**
 * Circuit breaker implementation for OT/CRDT sync operations.
 * Protects real-time collaboration from cascading failures.
 *
 * WHY: When database or Redis is slow/down, we want to:
 * 1. Fail fast instead of blocking all clients
 * 2. Allow the system to recover gracefully
 * 3. Provide fallback behavior for degraded operation
 */

import CircuitBreaker from 'opossum';
import logger from './logger.js';
import {
  circuitBreakerStateGauge,
  circuitBreakerEventsCounter,
} from './metrics.js';

/**
 * Circuit breaker options optimized for real-time collaboration.
 * - Short timeout: Users notice delay > 100ms
 * - Aggressive threshold: Fail fast on repeated errors
 * - Quick reset: Try to recover as soon as possible
 */
interface CircuitBreakerOptions {
  /** Timeout in milliseconds before operation is considered failed */
  timeout?: number;
  /** Number of failures before opening the circuit */
  errorThresholdPercentage?: number;
  /** Time in ms before attempting recovery (half-open state) */
  resetTimeout?: number;
  /** Minimum number of requests before error threshold applies */
  volumeThreshold?: number;
}

const defaultOptions: Required<CircuitBreakerOptions> = {
  timeout: 3000, // 3 seconds max for any operation
  errorThresholdPercentage: 50, // Open after 50% failures
  resetTimeout: 10000, // Try recovery after 10 seconds
  volumeThreshold: 5, // Need at least 5 requests to trip
};

/**
 * Creates a circuit breaker for a given async function.
 * Wraps the function with circuit breaker logic and metrics.
 *
 * @param name - Name for logging and metrics
 * @param fn - Async function to protect
 * @param options - Circuit breaker configuration
 * @returns Wrapped function with circuit breaker protection
 */
export function createCircuitBreaker<T extends (...args: unknown[]) => Promise<unknown>>(
  name: string,
  fn: T,
  options: CircuitBreakerOptions = {}
): CircuitBreaker<Parameters<T>, ReturnType<T>> {
  const opts = { ...defaultOptions, ...options };

  const breaker = new CircuitBreaker(fn, {
    timeout: opts.timeout,
    errorThresholdPercentage: opts.errorThresholdPercentage,
    resetTimeout: opts.resetTimeout,
    volumeThreshold: opts.volumeThreshold,
    name,
  });

  // Track state changes
  breaker.on('open', () => {
    logger.warn({ circuit: name }, 'Circuit breaker opened');
    circuitBreakerStateGauge.set({ circuit_name: name }, 1);
  });

  breaker.on('halfOpen', () => {
    logger.info({ circuit: name }, 'Circuit breaker half-open, testing recovery');
    circuitBreakerStateGauge.set({ circuit_name: name }, 2);
  });

  breaker.on('close', () => {
    logger.info({ circuit: name }, 'Circuit breaker closed, back to normal');
    circuitBreakerStateGauge.set({ circuit_name: name }, 0);
  });

  // Track events for metrics
  breaker.on('success', () => {
    circuitBreakerEventsCounter.inc({ circuit_name: name, event: 'success' });
  });

  breaker.on('failure', () => {
    circuitBreakerEventsCounter.inc({ circuit_name: name, event: 'failure' });
  });

  breaker.on('timeout', () => {
    circuitBreakerEventsCounter.inc({ circuit_name: name, event: 'timeout' });
    logger.warn({ circuit: name }, 'Circuit breaker timeout');
  });

  breaker.on('reject', () => {
    circuitBreakerEventsCounter.inc({ circuit_name: name, event: 'rejected' });
    logger.warn({ circuit: name }, 'Circuit breaker rejected request (circuit open)');
  });

  breaker.on('fallback', () => {
    circuitBreakerEventsCounter.inc({ circuit_name: name, event: 'fallback' });
  });

  // Initialize gauge to closed state
  circuitBreakerStateGauge.set({ circuit_name: name }, 0);

  return breaker;
}

/**
 * Pre-configured circuit breaker for OT sync operations.
 * Tighter timeouts because users are waiting for real-time updates.
 */
export const OT_SYNC_OPTIONS: CircuitBreakerOptions = {
  timeout: 2000, // 2 seconds - tight for real-time
  errorThresholdPercentage: 50,
  resetTimeout: 5000, // Quick recovery attempt
  volumeThreshold: 3,
};

/**
 * Pre-configured circuit breaker for database operations.
 * Slightly more lenient as DB ops may take longer.
 */
export const DB_OPTIONS: CircuitBreakerOptions = {
  timeout: 5000, // 5 seconds for DB
  errorThresholdPercentage: 50,
  resetTimeout: 15000,
  volumeThreshold: 5,
};

/**
 * Pre-configured circuit breaker for Redis operations.
 * Very tight timeout - Redis should be fast.
 */
export const REDIS_OPTIONS: CircuitBreakerOptions = {
  timeout: 1000, // 1 second - Redis should be fast
  errorThresholdPercentage: 50,
  resetTimeout: 5000,
  volumeThreshold: 5,
};

/**
 * Check if an error is a circuit breaker rejection.
 */
export function isCircuitOpen(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Breaker is open');
}

export default createCircuitBreaker;
