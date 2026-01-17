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

// Default options for circuit breakers
const DEFAULT_OPTIONS = {
  timeout: 10000, // 10 seconds
  errorThresholdPercentage: 50, // Trip after 50% failures
  resetTimeout: 30000, // Try again after 30 seconds
  volumeThreshold: 5, // Minimum requests before tripping
  rollingCountTimeout: 10000, // Rolling window for failure calculation
  rollingCountBuckets: 10, // Number of buckets in the rolling window
};

// Circuit breaker instances registry
const circuitBreakers = new Map();

/**
 * Create a circuit breaker for a given function
 *
 * @param {string} name - Unique name for the circuit breaker
 * @param {Function} fn - The function to wrap
 * @param {object} options - Circuit breaker options
 * @returns {CircuitBreaker}
 */
export function createCircuitBreaker(name, fn, options = {}) {
  const circuitOptions = {
    ...DEFAULT_OPTIONS,
    ...options,
    name,
  };

  const breaker = new CircuitBreaker(fn, circuitOptions);

  // Set up event handlers for logging and metrics
  breaker.on('success', (result, latencyMs) => {
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

  breaker.on('fallback', (result) => {
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
 *
 * @param {string} name - Circuit breaker name
 * @returns {CircuitBreaker|undefined}
 */
export function getCircuitBreaker(name) {
  return circuitBreakers.get(name);
}

/**
 * Get status of all circuit breakers
 *
 * @returns {object} Status object with all circuit breaker states
 */
export function getAllCircuitBreakerStatus() {
  const status = {};
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
export const REDIS_CIRCUIT_OPTIONS = {
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
export const FANOUT_CIRCUIT_OPTIONS = {
  timeout: 30000, // 30 second timeout for bulk operations
  errorThresholdPercentage: 60,
  resetTimeout: 60000, // 1 minute before retry
  volumeThreshold: 5,
};

/**
 * Database Circuit Breaker Configuration
 */
export const DATABASE_CIRCUIT_OPTIONS = {
  timeout: 10000, // 10 second timeout
  errorThresholdPercentage: 40,
  resetTimeout: 30000,
  volumeThreshold: 10,
};

/**
 * Create a wrapped function with circuit breaker protection
 *
 * @param {string} name - Circuit breaker name
 * @param {Function} fn - Function to wrap
 * @param {Function} fallback - Fallback function when circuit is open
 * @param {object} options - Circuit breaker options
 * @returns {Function} Wrapped function
 */
export function withCircuitBreaker(name, fn, fallback = null, options = {}) {
  const breaker = createCircuitBreaker(name, fn, options);

  if (fallback) {
    breaker.fallback(fallback);
  }

  // Return a function that fires the circuit breaker
  return async (...args) => {
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
