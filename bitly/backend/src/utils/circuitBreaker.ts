/**
 * Circuit breaker implementation using opossum.
 * Protects against cascading failures by failing fast when
 * downstream services (database, cache) are unhealthy.
 */
import CircuitBreaker from 'opossum';
import logger from './logger.js';
import { circuitBreakerState } from './metrics.js';

/**
 * Default circuit breaker configuration.
 * Tuned for database operations with reasonable timeouts.
 */
const defaultOptions: CircuitBreaker.Options = {
  timeout: 3000, // 3 second timeout for operations
  errorThresholdPercentage: 50, // Open circuit when 50% of requests fail
  resetTimeout: 30000, // Try again after 30 seconds
  volumeThreshold: 5, // Minimum requests before circuit can open
  rollingCountTimeout: 10000, // Time window for error rate calculation
  rollingCountBuckets: 10, // Number of buckets for rolling window
};

/**
 * Creates a circuit breaker wrapper for an async function.
 * Monitors the function's health and opens the circuit when failure rate exceeds threshold.
 *
 * @param fn - The async function to wrap
 * @param name - Name for logging and metrics
 * @param options - Optional circuit breaker configuration overrides
 * @returns Circuit breaker instance wrapping the function
 */
export function createCircuitBreaker<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  name: string,
  options: Partial<CircuitBreaker.Options> = {}
): CircuitBreaker<Parameters<T>, Awaited<ReturnType<T>>> {
  const breaker = new CircuitBreaker(fn, {
    ...defaultOptions,
    ...options,
    name,
  });

  // Log and track circuit state changes
  breaker.on('open', () => {
    logger.warn({ circuit: name }, 'Circuit breaker opened');
    circuitBreakerState.set({ name }, 1);
  });

  breaker.on('halfOpen', () => {
    logger.info({ circuit: name }, 'Circuit breaker half-open, testing');
    circuitBreakerState.set({ name }, 0.5);
  });

  breaker.on('close', () => {
    logger.info({ circuit: name }, 'Circuit breaker closed');
    circuitBreakerState.set({ name }, 0);
  });

  breaker.on('fallback', (result) => {
    logger.debug({ circuit: name, result }, 'Circuit breaker fallback executed');
  });

  breaker.on('timeout', () => {
    logger.warn({ circuit: name }, 'Circuit breaker timeout');
  });

  breaker.on('reject', () => {
    logger.warn({ circuit: name }, 'Circuit breaker rejected request (circuit open)');
  });

  // Initialize state metric
  circuitBreakerState.set({ name }, 0);

  return breaker;
}

/**
 * Database circuit breaker for query operations.
 * Opens when database queries consistently fail or timeout.
 */
export const dbCircuitBreakerOptions: Partial<CircuitBreaker.Options> = {
  timeout: 5000, // 5 second timeout for DB operations
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
  volumeThreshold: 10,
};

/**
 * Redis circuit breaker for cache operations.
 * Configured with shorter timeouts since cache should be fast.
 */
export const redisCircuitBreakerOptions: Partial<CircuitBreaker.Options> = {
  timeout: 1000, // 1 second timeout for cache operations
  errorThresholdPercentage: 50,
  resetTimeout: 10000, // Try again after 10 seconds
  volumeThreshold: 10,
};

export default createCircuitBreaker;
