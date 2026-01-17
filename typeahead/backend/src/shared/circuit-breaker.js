/**
 * Circuit breaker implementation using opossum.
 *
 * WHY circuit breakers are CRITICAL for typeahead:
 * - Protects the search index from cascading failures
 * - Prevents thundering herd when recovering from failures
 * - Provides graceful degradation with fallback suggestions
 * - Enables fast-fail instead of slow timeouts
 */
import CircuitBreaker from 'opossum';
import logger, { auditLogger } from './logger.js';
import { circuitBreakerMetrics } from './metrics.js';

// Default circuit breaker options
const DEFAULT_OPTIONS = {
  timeout: 100, // 100ms timeout (typeahead needs to be fast)
  errorThresholdPercentage: 50, // Open circuit if 50% of requests fail
  resetTimeout: 10000, // Try again after 10 seconds
  volumeThreshold: 5, // Minimum requests before tripping
};

// Map to store circuit breakers by name
const circuits = new Map();

/**
 * Create or get a circuit breaker for a named operation
 * @param {string} name - Unique name for this circuit
 * @param {Function} action - The async function to wrap
 * @param {Object} options - Circuit breaker options
 * @param {Function} fallback - Fallback function when circuit is open
 */
export function createCircuitBreaker(name, action, options = {}, fallback = null) {
  if (circuits.has(name)) {
    return circuits.get(name);
  }

  const circuitOptions = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  const breaker = new CircuitBreaker(action, circuitOptions);

  // Setup event handlers for logging and metrics
  breaker.on('success', () => {
    circuitBreakerMetrics.state.set({ circuit_name: name }, 0); // 0 = closed
  });

  breaker.on('failure', (error) => {
    logger.warn({
      event: 'circuit_failure',
      circuit: name,
      error: error?.message || 'unknown',
    });
    circuitBreakerMetrics.failures.inc({ circuit_name: name });
  });

  breaker.on('open', () => {
    auditLogger.logCircuitStateChange(name, 'closed', 'open', 'failure threshold exceeded');
    circuitBreakerMetrics.state.set({ circuit_name: name }, 2); // 2 = open
  });

  breaker.on('halfOpen', () => {
    auditLogger.logCircuitStateChange(name, 'open', 'half-open', 'reset timeout elapsed');
    circuitBreakerMetrics.state.set({ circuit_name: name }, 1); // 1 = half-open
  });

  breaker.on('close', () => {
    auditLogger.logCircuitStateChange(name, 'half-open', 'closed', 'successful request');
    circuitBreakerMetrics.state.set({ circuit_name: name }, 0); // 0 = closed
  });

  breaker.on('fallback', () => {
    logger.info({
      event: 'circuit_fallback',
      circuit: name,
    });
    circuitBreakerMetrics.fallbacks.inc({ circuit_name: name });
  });

  breaker.on('timeout', () => {
    logger.warn({
      event: 'circuit_timeout',
      circuit: name,
      timeout: circuitOptions.timeout,
    });
  });

  // Set fallback if provided
  if (fallback) {
    breaker.fallback(fallback);
  }

  // Initialize metrics
  circuitBreakerMetrics.state.set({ circuit_name: name }, 0);

  circuits.set(name, breaker);
  return breaker;
}

/**
 * Get circuit breaker by name
 */
export function getCircuitBreaker(name) {
  return circuits.get(name);
}

/**
 * Get all circuit breaker statuses
 */
export function getCircuitStatus() {
  const status = {};
  for (const [name, breaker] of circuits) {
    status[name] = {
      state: breaker.opened ? 'open' : (breaker.halfOpen ? 'half-open' : 'closed'),
      stats: breaker.stats,
      options: {
        timeout: breaker.options.timeout,
        errorThresholdPercentage: breaker.options.errorThresholdPercentage,
        resetTimeout: breaker.options.resetTimeout,
      },
    };
  }
  return status;
}

/**
 * Reset all circuits (for testing)
 */
export function resetAllCircuits() {
  for (const breaker of circuits.values()) {
    breaker.close();
  }
}

/**
 * Create a suggestion service circuit breaker
 * Used to wrap trie queries with circuit breaker protection
 */
export function createSuggestionCircuitBreaker(suggestionFn, fallbackFn) {
  return createCircuitBreaker(
    'suggestion_service',
    suggestionFn,
    {
      timeout: 50, // 50ms for suggestions (very tight)
      errorThresholdPercentage: 30, // Open if 30% fail
      resetTimeout: 5000, // Try again after 5 seconds
      volumeThreshold: 10, // Need at least 10 requests
    },
    fallbackFn
  );
}

/**
 * Create a database circuit breaker
 * Used to wrap PostgreSQL queries
 */
export function createDatabaseCircuitBreaker(dbFn, fallbackFn) {
  return createCircuitBreaker(
    'database',
    dbFn,
    {
      timeout: 1000, // 1 second for DB operations
      errorThresholdPercentage: 50,
      resetTimeout: 15000, // 15 seconds
      volumeThreshold: 5,
    },
    fallbackFn
  );
}

/**
 * Create a Redis circuit breaker
 * Used to wrap Redis cache operations
 */
export function createRedisCircuitBreaker(redisFn, fallbackFn) {
  return createCircuitBreaker(
    'redis_cache',
    redisFn,
    {
      timeout: 50, // 50ms for cache (fast fail)
      errorThresholdPercentage: 50,
      resetTimeout: 5000,
      volumeThreshold: 10,
    },
    fallbackFn
  );
}

export default {
  createCircuitBreaker,
  getCircuitBreaker,
  getCircuitStatus,
  resetAllCircuits,
  createSuggestionCircuitBreaker,
  createDatabaseCircuitBreaker,
  createRedisCircuitBreaker,
};
