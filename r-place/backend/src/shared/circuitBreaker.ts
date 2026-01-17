/**
 * Circuit breaker implementation for Redis operations.
 *
 * Prevents cascading failures when Redis becomes unavailable by:
 * - Opening the circuit after consecutive failures
 * - Failing fast during open state
 * - Periodically testing recovery in half-open state
 * - Closing the circuit when Redis recovers
 *
 * Uses the opossum library for robust circuit breaker patterns.
 */
import CircuitBreaker from 'opossum';
import { logger, logCircuitBreakerEvent } from './logger.js';
import { circuitBreakerState } from './metrics.js';

/**
 * Default options for Redis circuit breakers.
 */
const DEFAULT_OPTIONS: CircuitBreaker.Options = {
  // Open the circuit after 5 failures
  errorThresholdPercentage: 50,
  // Minimum requests before calculating error threshold
  volumeThreshold: 5,
  // Time window for calculating error percentage (10 seconds)
  rollingCountTimeout: 10000,
  // Time to wait before testing if Redis has recovered (30 seconds)
  resetTimeout: 30000,
  // Timeout for individual operations (5 seconds)
  timeout: 5000,
  // Allow the first request through when entering half-open state
  allowWarmUp: true,
};

/**
 * Creates a circuit breaker for a Redis operation.
 *
 * @param name - Name for logging and metrics.
 * @param fn - The async function to protect.
 * @param options - Optional circuit breaker configuration overrides.
 * @returns A circuit breaker wrapping the function.
 */
export function createRedisCircuitBreaker<TArgs extends unknown[], TResult>(
  name: string,
  fn: (...args: TArgs) => Promise<TResult>,
  options?: Partial<CircuitBreaker.Options>
): CircuitBreaker<TArgs, TResult> {
  const breaker = new CircuitBreaker<TArgs, TResult>(fn, {
    ...DEFAULT_OPTIONS,
    ...options,
    name,
  });

  // Log and track state changes
  breaker.on('open', () => {
    logCircuitBreakerEvent({ name, event: 'open' });
    circuitBreakerState.set({ name }, 1);
  });

  breaker.on('close', () => {
    logCircuitBreakerEvent({ name, event: 'close' });
    circuitBreakerState.set({ name }, 0);
  });

  breaker.on('halfOpen', () => {
    logCircuitBreakerEvent({ name, event: 'halfOpen' });
    circuitBreakerState.set({ name }, 0.5);
  });

  breaker.on('fallback', (result) => {
    logCircuitBreakerEvent({
      name,
      event: 'fallback',
      error: result instanceof Error ? result.message : String(result),
    });
  });

  // Initialize metric
  circuitBreakerState.set({ name }, 0);

  return breaker;
}

/**
 * Creates a simple fallback function that returns a default value.
 *
 * @param defaultValue - The value to return when the circuit is open.
 * @returns A fallback function.
 */
export function createFallback<T>(defaultValue: T): () => T {
  return () => {
    logger.warn({ event: 'circuit_breaker_fallback' }, 'Using fallback value due to open circuit');
    return defaultValue;
  };
}

/**
 * Wraps an async function with circuit breaker protection.
 * Returns both the breaker and a convenience fire method.
 *
 * @param name - Name for the circuit breaker.
 * @param fn - The async function to protect.
 * @param fallback - Optional fallback value when circuit is open.
 * @returns Object with fire method and circuit state helpers.
 */
export function withCircuitBreaker<TArgs extends unknown[], TResult>(
  name: string,
  fn: (...args: TArgs) => Promise<TResult>,
  fallback?: TResult
): {
  fire: (...args: TArgs) => Promise<TResult>;
  isOpen: () => boolean;
  isClosed: () => boolean;
  breaker: CircuitBreaker<TArgs, TResult>;
} {
  const breaker = createRedisCircuitBreaker<TArgs, TResult>(name, fn);

  if (fallback !== undefined) {
    breaker.fallback(createFallback(fallback));
  }

  return {
    fire: (...args: TArgs) => breaker.fire(...args),
    isOpen: () => breaker.opened,
    isClosed: () => breaker.closed,
    breaker,
  };
}
