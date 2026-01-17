/**
 * Circuit Breaker Module
 *
 * Provides circuit breaker pattern implementation using opossum library.
 * Protects against cascading failures when database or external services are degraded.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Failures exceeded threshold, requests fail fast
 * - HALF-OPEN: Testing if service recovered, allowing one request through
 *
 * @module shared/circuitBreaker
 */

import CircuitBreaker from 'opossum';
import { logger } from './logger.js';
import {
  circuitBreakerStateGauge,
  circuitBreakerFailuresCounter,
} from './metrics.js';

/** Circuit breaker state mapping for metrics */
const STATE_VALUES = {
  closed: 0,
  open: 1,
  halfOpen: 2,
} as const;

/**
 * Circuit breaker configuration options.
 */
export interface CircuitBreakerOptions {
  /** Name for logging and metrics */
  name: string;
  /** Timeout for wrapped function in milliseconds */
  timeout?: number;
  /** Error threshold percentage to open circuit (0-100) */
  errorThresholdPercentage?: number;
  /** Time in milliseconds before attempting to close after opening */
  resetTimeout?: number;
  /** Number of requests before calculating error percentage */
  volumeThreshold?: number;
}

/**
 * Default circuit breaker settings optimized for database operations.
 */
const DEFAULT_OPTIONS = {
  timeout: 5000,              // 5 second timeout
  errorThresholdPercentage: 50, // Open after 50% failures
  resetTimeout: 10000,        // Try again after 10 seconds
  volumeThreshold: 5,         // Need 5 requests before opening
};

/**
 * Creates a circuit breaker for any async function.
 *
 * @template T - Function arguments type
 * @template R - Function return type
 * @param fn - The async function to wrap
 * @param options - Circuit breaker configuration
 * @returns Wrapped function with circuit breaker protection
 *
 * @example
 * const protectedQuery = createCircuitBreaker(
 *   async (sql: string) => db.query(sql),
 *   { name: 'db-query' }
 * );
 * const result = await protectedQuery('SELECT * FROM users');
 */
export function createCircuitBreaker<T extends unknown[], R>(
  fn: (...args: T) => Promise<R>,
  options: CircuitBreakerOptions
): (...args: T) => Promise<R> {
  const breaker = new CircuitBreaker(fn, {
    ...DEFAULT_OPTIONS,
    ...options,
  });

  const breakerLogger = logger.child({ circuitBreaker: options.name });

  // Log and track state changes
  breaker.on('open', () => {
    breakerLogger.warn('Circuit breaker OPENED - failing fast');
    circuitBreakerStateGauge.labels(options.name).set(STATE_VALUES.open);
  });

  breaker.on('close', () => {
    breakerLogger.info('Circuit breaker CLOSED - normal operation resumed');
    circuitBreakerStateGauge.labels(options.name).set(STATE_VALUES.closed);
  });

  breaker.on('halfOpen', () => {
    breakerLogger.info('Circuit breaker HALF-OPEN - testing recovery');
    circuitBreakerStateGauge.labels(options.name).set(STATE_VALUES.halfOpen);
  });

  breaker.on('failure', (error) => {
    breakerLogger.error({ error: error?.message }, 'Circuit breaker recorded failure');
    circuitBreakerFailuresCounter.labels(options.name).inc();
  });

  breaker.on('timeout', () => {
    breakerLogger.warn('Circuit breaker timeout exceeded');
    circuitBreakerFailuresCounter.labels(options.name).inc();
  });

  breaker.on('reject', () => {
    breakerLogger.warn('Circuit breaker rejected request - circuit is open');
  });

  breaker.on('fallback', () => {
    breakerLogger.debug('Circuit breaker fallback executed');
  });

  // Initialize metrics
  circuitBreakerStateGauge.labels(options.name).set(STATE_VALUES.closed);

  return (...args: T) => breaker.fire(...args) as Promise<R>;
}

/**
 * Pre-configured circuit breaker for PostgreSQL database operations.
 * - 5 second timeout (queries should be fast)
 * - Opens after 5 failures in 30 seconds
 * - Recovers after 10 seconds
 */
export function createDatabaseCircuitBreaker<T extends unknown[], R>(
  fn: (...args: T) => Promise<R>,
  operationName: string
): (...args: T) => Promise<R> {
  return createCircuitBreaker(fn, {
    name: `db-${operationName}`,
    timeout: 5000,
    errorThresholdPercentage: 50,
    resetTimeout: 10000,
    volumeThreshold: 5,
  });
}

/**
 * Pre-configured circuit breaker for Redis operations.
 * - Shorter timeout (Redis should be very fast)
 * - Opens after 5 failures
 * - Recovers after 5 seconds (Redis recovers quickly)
 */
export function createRedisCircuitBreaker<T extends unknown[], R>(
  fn: (...args: T) => Promise<R>,
  operationName: string
): (...args: T) => Promise<R> {
  return createCircuitBreaker(fn, {
    name: `redis-${operationName}`,
    timeout: 2000,
    errorThresholdPercentage: 50,
    resetTimeout: 5000,
    volumeThreshold: 5,
  });
}
