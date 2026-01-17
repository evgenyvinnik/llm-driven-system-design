/**
 * Circuit breaker implementation for external service calls.
 * Protects the system from cascading failures when dependencies become unavailable.
 *
 * Circuit breaker states:
 * - CLOSED: Requests flow normally
 * - OPEN: Requests fail immediately (service is down)
 * - HALF-OPEN: Test requests to check if service recovered
 *
 * Use cases for Robinhood:
 * - Market data provider outages
 * - Order execution service failures
 * - Database connection issues
 */

import CircuitBreaker from 'opossum';
import { logger } from './logger.js';
import { circuitBreakerStateGauge, circuitBreakerFailuresTotal } from './metrics.js';

/**
 * Circuit breaker configuration options
 */
export interface CircuitBreakerOptions {
  /** Name for logging and metrics */
  name: string;
  /** Time in ms before attempting to reset */
  timeout?: number;
  /** Number of failures before opening */
  errorThresholdPercentage?: number;
  /** Minimum number of requests before calculating error threshold */
  volumeThreshold?: number;
  /** Time in ms to wait before switching from open to half-open */
  resetTimeout?: number;
}

/** Default circuit breaker settings */
const DEFAULT_OPTIONS = {
  timeout: 3000, // 3 seconds timeout
  errorThresholdPercentage: 50, // Open after 50% failures
  volumeThreshold: 5, // Need at least 5 requests
  resetTimeout: 30000, // 30 seconds before trying again
};

/**
 * Creates a circuit breaker wrapper for an async function.
 * @param fn - Async function to wrap
 * @param options - Circuit breaker configuration
 * @returns Wrapped function with circuit breaker protection
 */
export function createCircuitBreaker<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: CircuitBreakerOptions
): CircuitBreaker<TArgs, TResult> {
  const config = { ...DEFAULT_OPTIONS, ...options };

  const breaker = new CircuitBreaker<TArgs, TResult>(fn, {
    timeout: config.timeout,
    errorThresholdPercentage: config.errorThresholdPercentage,
    volumeThreshold: config.volumeThreshold,
    resetTimeout: config.resetTimeout,
    name: config.name,
  });

  // Log and track state changes
  breaker.on('open', () => {
    logger.warn({ circuitBreaker: config.name }, 'Circuit breaker OPENED - service unavailable');
    circuitBreakerStateGauge.set({ name: config.name }, 1);
  });

  breaker.on('halfOpen', () => {
    logger.info({ circuitBreaker: config.name }, 'Circuit breaker HALF-OPEN - testing service');
    circuitBreakerStateGauge.set({ name: config.name }, 2);
  });

  breaker.on('close', () => {
    logger.info({ circuitBreaker: config.name }, 'Circuit breaker CLOSED - service recovered');
    circuitBreakerStateGauge.set({ name: config.name }, 0);
  });

  breaker.on('failure', (error: Error) => {
    logger.error({ circuitBreaker: config.name, error: error.message }, 'Circuit breaker recorded failure');
    circuitBreakerFailuresTotal.inc({ name: config.name });
  });

  breaker.on('timeout', () => {
    logger.warn({ circuitBreaker: config.name }, 'Circuit breaker timeout');
  });

  breaker.on('fallback', () => {
    logger.debug({ circuitBreaker: config.name }, 'Circuit breaker fallback executed');
  });

  // Initialize gauge to closed state
  circuitBreakerStateGauge.set({ name: config.name }, 0);

  return breaker;
}

/**
 * Circuit breaker state enum for external use.
 */
export enum CircuitBreakerState {
  CLOSED = 0,
  OPEN = 1,
  HALF_OPEN = 2,
}

/**
 * Gets the current state of a circuit breaker.
 * @param breaker - Circuit breaker instance
 * @returns Current state
 */
export function getCircuitBreakerState(breaker: CircuitBreaker): CircuitBreakerState {
  if (breaker.opened) return CircuitBreakerState.OPEN;
  if (breaker.halfOpen) return CircuitBreakerState.HALF_OPEN;
  return CircuitBreakerState.CLOSED;
}

/**
 * Creates a fallback function that returns a default value.
 * @param defaultValue - Value to return when circuit is open
 * @returns Fallback function
 */
export function createFallback<T>(defaultValue: T): () => T {
  return () => defaultValue;
}
