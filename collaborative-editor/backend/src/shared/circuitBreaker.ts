/**
 * @fileoverview Circuit breaker implementation for protecting critical operations.
 *
 * Uses the opossum library to implement the circuit breaker pattern:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Failures exceeded threshold, requests fail fast
 * - HALF-OPEN: Testing if service recovered
 *
 * Circuit breakers protect:
 * - Database operations (OT apply, snapshot save)
 * - Redis operations (presence updates)
 * - RabbitMQ operations (message publish)
 *
 * This prevents cascading failures and enables graceful degradation.
 */

import CircuitBreaker from 'opossum';
import { logger, logCircuitBreaker } from './logger.js';
import {
  circuitBreakerState,
  circuitBreakerTrips,
} from './metrics.js';

/**
 * Default options for circuit breakers.
 * Tuned for real-time collaboration requirements.
 */
const DEFAULT_OPTIONS: CircuitBreaker.Options = {
  timeout: 3000, // 3s timeout per operation
  errorThresholdPercentage: 50, // Open after 50% failures
  resetTimeout: 30000, // Try again after 30s
  volumeThreshold: 5, // Minimum 5 requests before tripping
};

/**
 * Create a circuit breaker with logging and metrics.
 *
 * @param name - Name of the protected service
 * @param fn - The async function to protect
 * @param options - Circuit breaker options (merged with defaults)
 * @returns A circuit breaker instance
 */
export function createCircuitBreaker<TArgs extends unknown[], TResult>(
  name: string,
  fn: (...args: TArgs) => Promise<TResult>,
  options: Partial<CircuitBreaker.Options> = {}
): CircuitBreaker<TArgs, TResult> {
  const breaker = new CircuitBreaker(fn, {
    ...DEFAULT_OPTIONS,
    ...options,
    name,
  });

  // Set up event handlers for logging and metrics
  breaker.on('open', () => {
    logCircuitBreaker(name, 'open');
    circuitBreakerState.set({ service: name }, 1);
    circuitBreakerTrips.inc({ service: name });
  });

  breaker.on('halfOpen', () => {
    logCircuitBreaker(name, 'half_open');
    circuitBreakerState.set({ service: name }, 0.5);
  });

  breaker.on('close', () => {
    logCircuitBreaker(name, 'close');
    circuitBreakerState.set({ service: name }, 0);
  });

  breaker.on('fallback', () => {
    logger.debug({ event: 'circuit_fallback', service: name });
  });

  breaker.on('timeout', () => {
    logger.warn({ event: 'circuit_timeout', service: name });
  });

  // Initialize state to closed
  circuitBreakerState.set({ service: name }, 0);

  return breaker;
}

/**
 * OT-specific circuit breaker options.
 * More aggressive timeouts since OT must be fast for real-time feel.
 */
export const OT_BREAKER_OPTIONS: Partial<CircuitBreaker.Options> = {
  timeout: 1000, // 1s - OT must be fast
  errorThresholdPercentage: 30, // Open earlier for OT
  resetTimeout: 15000, // Recover faster
  volumeThreshold: 3,
};

/**
 * Database circuit breaker options.
 * Slightly longer timeouts for DB operations.
 */
export const DB_BREAKER_OPTIONS: Partial<CircuitBreaker.Options> = {
  timeout: 5000, // 5s for DB
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
  volumeThreshold: 5,
};

/**
 * Redis circuit breaker options.
 * Fast timeout since Redis should be quick.
 */
export const REDIS_BREAKER_OPTIONS: Partial<CircuitBreaker.Options> = {
  timeout: 1000, // 1s for Redis
  errorThresholdPercentage: 50,
  resetTimeout: 10000, // Faster recovery
  volumeThreshold: 10,
};

/**
 * RabbitMQ circuit breaker options.
 */
export const RABBIT_BREAKER_OPTIONS: Partial<CircuitBreaker.Options> = {
  timeout: 2000, // 2s for message publish
  errorThresholdPercentage: 50,
  resetTimeout: 15000,
  volumeThreshold: 5,
};
