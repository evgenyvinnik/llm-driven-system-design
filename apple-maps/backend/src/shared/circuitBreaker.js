import CircuitBreaker from 'opossum';
import logger from './logger.js';
import {
  circuitBreakerState,
  circuitBreakerFailures,
  circuitBreakerSuccesses,
} from './metrics.js';

/**
 * Circuit Breaker Module using Opossum
 *
 * WHY: Circuit breakers prevent cascading failures by:
 * - Failing fast when downstream services are unhealthy
 * - Reducing load on failing services to allow recovery
 * - Providing fallback responses for graceful degradation
 * - Automatically attempting recovery after cooldown period
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Service unhealthy, requests fail immediately
 * - HALF-OPEN: Testing if service recovered
 */

// Default circuit breaker options
const DEFAULT_OPTIONS = {
  timeout: 5000, // 5 seconds timeout for wrapped function
  errorThresholdPercentage: 50, // Open if 50% of requests fail
  resetTimeout: 30000, // 30 seconds before trying again
  volumeThreshold: 5, // Minimum requests before considering opening
};

// Store all circuit breakers for health reporting
const circuitBreakers = new Map();

/**
 * Create a circuit breaker for a function
 * @param {string} name - Unique name for the breaker
 * @param {Function} fn - Async function to wrap
 * @param {Object} options - Circuit breaker options
 * @param {Function} fallback - Optional fallback function
 */
function createCircuitBreaker(name, fn, options = {}, fallback = null) {
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options, name };

  const breaker = new CircuitBreaker(fn, mergedOptions);

  // Set up event listeners for logging and metrics
  breaker.on('success', () => {
    circuitBreakerSuccesses.inc({ name });
    circuitBreakerState.set({ name }, 0); // CLOSED = 0
  });

  breaker.on('failure', (error) => {
    circuitBreakerFailures.inc({ name });
    logger.warn({ circuit: name, error: error.message }, 'Circuit breaker recorded failure');
  });

  breaker.on('open', () => {
    circuitBreakerState.set({ name }, 1); // OPEN = 1
    logger.error({ circuit: name }, 'Circuit breaker OPENED - failing fast');
  });

  breaker.on('halfOpen', () => {
    circuitBreakerState.set({ name }, 0.5); // HALF-OPEN = 0.5
    logger.info({ circuit: name }, 'Circuit breaker HALF-OPEN - testing recovery');
  });

  breaker.on('close', () => {
    circuitBreakerState.set({ name }, 0); // CLOSED = 0
    logger.info({ circuit: name }, 'Circuit breaker CLOSED - service recovered');
  });

  breaker.on('timeout', () => {
    logger.warn({ circuit: name }, 'Circuit breaker timeout');
  });

  breaker.on('reject', () => {
    logger.warn({ circuit: name }, 'Circuit breaker rejected request (circuit open)');
  });

  // Optional fallback
  if (fallback) {
    breaker.fallback(fallback);
  }

  // Store for health reporting
  circuitBreakers.set(name, breaker);

  // Initialize metric
  circuitBreakerState.set({ name }, 0);

  return breaker;
}

/**
 * Get health status of all circuit breakers
 */
function getCircuitBreakerHealth() {
  const health = {};
  for (const [name, breaker] of circuitBreakers) {
    const stats = breaker.stats;
    health[name] = {
      state: breaker.opened ? 'OPEN' : breaker.halfOpen ? 'HALF-OPEN' : 'CLOSED',
      stats: {
        successes: stats.successes,
        failures: stats.failures,
        timeouts: stats.timeouts,
        rejects: stats.rejects,
        fallbacks: stats.fallbacks,
      },
    };
  }
  return health;
}

/**
 * Preconfigured circuit breakers for common operations
 */

// Routing service circuit breaker for graph loading
const routingCircuitBreakerOptions = {
  timeout: 10000, // 10 seconds for complex routes
  errorThresholdPercentage: 60,
  resetTimeout: 60000, // 1 minute cooldown
  volumeThreshold: 3,
};

// Geocoding service circuit breaker
const geocodingCircuitBreakerOptions = {
  timeout: 5000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
  volumeThreshold: 5,
};

// External traffic provider circuit breaker (if using external APIs)
const externalTrafficCircuitBreakerOptions = {
  timeout: 3000, // Fast timeout for external calls
  errorThresholdPercentage: 40,
  resetTimeout: 60000,
  volumeThreshold: 10,
};

// Database circuit breaker options
const databaseCircuitBreakerOptions = {
  timeout: 5000,
  errorThresholdPercentage: 30, // Lower threshold for DB
  resetTimeout: 15000, // Faster recovery attempt
  volumeThreshold: 5,
};

export {
  createCircuitBreaker,
  getCircuitBreakerHealth,
  routingCircuitBreakerOptions,
  geocodingCircuitBreakerOptions,
  externalTrafficCircuitBreakerOptions,
  databaseCircuitBreakerOptions,
  circuitBreakers,
};
