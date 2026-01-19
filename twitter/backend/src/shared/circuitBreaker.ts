import CircuitBreaker from 'opossum';
import logger from './logger.js';
import { circuitBreakerState, circuitBreakerTrips } from './metrics.js';

/**
 * Circuit Breaker Factory
 *
 * Creates circuit breakers for external service calls to prevent cascading failures.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Failures exceeded threshold, requests fail fast
 * - HALF_OPEN: Testing if service recovered, allowing limited requests
 */

export interface CircuitBreakerOptions {
  timeout?: number;
  errorThresholdPercentage?: number;
  resetTimeout?: number;
  volumeThreshold?: number;
  rollingCountTimeout?: number;
  rollingCountBuckets?: number;
  name?: string;
}

// Default options for circuit breakers
const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  timeout: 10000, // 10 seconds
  errorThresholdPercentage: 50, // Trip after 50% failures
  resetTimeout: 30000, // Try again after 30 seconds
  volumeThreshold: 5, // Minimum requests before tripping
  rollingCountTimeout: 10000, // Rolling window for failure calculation
  rollingCountBuckets: 10, // Number of buckets in the rolling window
};

// Circuit breaker instances registry
const circuitBreakers = new Map<string, CircuitBreaker>();

/**
 * Create a circuit breaker for a given function
 */
export function createCircuitBreaker(
  name: string,
  fn: (...args: unknown[]) => Promise<unknown>,
  options: CircuitBreakerOptions = {}
): CircuitBreaker {
  const circuitOptions = {
    ...DEFAULT_OPTIONS,
    ...options,
    name,
  };

  const breaker = new CircuitBreaker(fn, circuitOptions);

  // Set up event handlers for logging and metrics
  breaker.on('success', (_result: unknown, latencyMs: number) => {
    logger.debug({ circuit: name, latencyMs }, 'Circuit breaker call succeeded');
  });

  breaker.on('timeout', () => {
    logger.warn({ circuit: name }, 'Circuit breaker call timed out');
  });

  breaker.on('reject', () => {
    logger.warn({ circuit: name }, 'Circuit breaker rejected call (circuit open)');
  });

  breaker.on('open', () => {
    logger.error({ circuit: name }, 'Circuit breaker opened - too many failures');
    circuitBreakerState.set({ circuit_name: name }, 2); // OPEN = 2
    circuitBreakerTrips.inc({ circuit_name: name });
  });

  breaker.on('halfOpen', () => {
    logger.info({ circuit: name }, 'Circuit breaker half-open - testing recovery');
    circuitBreakerState.set({ circuit_name: name }, 1); // HALF_OPEN = 1
  });

  breaker.on('close', () => {
    logger.info({ circuit: name }, 'Circuit breaker closed - service recovered');
    circuitBreakerState.set({ circuit_name: name }, 0); // CLOSED = 0
  });

  breaker.on('fallback', (result: unknown) => {
    logger.info({ circuit: name, fallbackResult: typeof result }, 'Circuit breaker using fallback');
  });

  // Initialize metrics state
  circuitBreakerState.set({ circuit_name: name }, 0); // Start CLOSED

  // Store in registry
  circuitBreakers.set(name, breaker);

  return breaker;
}

/**
 * Get an existing circuit breaker by name
 */
export function getCircuitBreaker(name: string): CircuitBreaker | undefined {
  return circuitBreakers.get(name);
}

interface CircuitBreakerStatus {
  state: 'OPEN' | 'HALF_OPEN' | 'CLOSED';
  stats: unknown;
}

/**
 * Get status of all circuit breakers
 */
export function getAllCircuitBreakerStatus(): Record<string, CircuitBreakerStatus> {
  const status: Record<string, CircuitBreakerStatus> = {};
  for (const [name, breaker] of circuitBreakers) {
    status[name] = {
      state: breaker.opened ? 'OPEN' : breaker.halfOpen ? 'HALF_OPEN' : 'CLOSED',
      stats: breaker.stats,
    };
  }
  return status;
}

/**
 * Pre-configured circuit breakers for common services
 */

/**
 * Redis Circuit Breaker Configuration
 */
export const REDIS_CIRCUIT_OPTIONS: CircuitBreakerOptions = {
  timeout: 5000, // 5 second timeout for Redis
  errorThresholdPercentage: 50,
  resetTimeout: 15000, // Retry faster for Redis
  volumeThreshold: 10,
};

/**
 * Fanout Service Circuit Breaker Configuration
 *
 * More lenient because fanout is not user-facing critical path
 */
export const FANOUT_CIRCUIT_OPTIONS: CircuitBreakerOptions = {
  timeout: 30000, // 30 second timeout for bulk operations
  errorThresholdPercentage: 60,
  resetTimeout: 60000, // 1 minute before retry
  volumeThreshold: 5,
};

/**
 * Database Circuit Breaker Configuration
 */
export const DATABASE_CIRCUIT_OPTIONS: CircuitBreakerOptions = {
  timeout: 10000, // 10 second timeout
  errorThresholdPercentage: 40,
  resetTimeout: 30000,
  volumeThreshold: 10,
};

/**
 * Create a wrapped function with circuit breaker protection
 */
export function withCircuitBreaker<T extends (...args: unknown[]) => Promise<unknown>>(
  name: string,
  fn: T,
  fallback: ((...args: unknown[]) => Promise<unknown>) | null = null,
  options: CircuitBreakerOptions = {}
): (...args: Parameters<T>) => Promise<unknown> {
  const breaker = createCircuitBreaker(name, fn, options);

  if (fallback) {
    breaker.fallback(fallback);
  }

  // Return a function that fires the circuit breaker
  return async (...args: Parameters<T>) => {
    return breaker.fire(...args);
  };
}

export default {
  createCircuitBreaker,
  getCircuitBreaker,
  getAllCircuitBreakerStatus,
  withCircuitBreaker,
  REDIS_CIRCUIT_OPTIONS,
  FANOUT_CIRCUIT_OPTIONS,
  DATABASE_CIRCUIT_OPTIONS,
};
