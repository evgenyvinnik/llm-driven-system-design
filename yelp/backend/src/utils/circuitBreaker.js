import CircuitBreaker from 'opossum';
import { logger, logCircuitBreaker } from './logger.js';
import {
  circuitBreakerFailures,
  circuitBreakerSuccesses,
  updateCircuitBreakerState,
} from './metrics.js';

/**
 * Circuit Breaker Module
 *
 * Implements the circuit breaker pattern for external service calls:
 * - Elasticsearch search and geo operations
 * - PostgreSQL geo queries (heavy operations)
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Service is failing, requests are rejected immediately
 * - HALF_OPEN: Testing if service recovered, limited requests allowed
 */

// Default circuit breaker options
const DEFAULT_OPTIONS = {
  timeout: 5000, // 5 second timeout
  errorThresholdPercentage: 50, // Open circuit if 50% of requests fail
  resetTimeout: 30000, // Try again after 30 seconds
  volumeThreshold: 5, // Minimum requests before circuit can open
};

// Store all circuit breakers for health checks
const circuitBreakers = new Map();

/**
 * Create a circuit breaker for a given function
 *
 * @param {string} name - Name for the circuit breaker (used in logs/metrics)
 * @param {Function} fn - The function to wrap
 * @param {object} options - Circuit breaker options
 * @returns {CircuitBreaker}
 */
export function createCircuitBreaker(name, fn, options = {}) {
  const breaker = new CircuitBreaker(fn, {
    ...DEFAULT_OPTIONS,
    ...options,
    name,
  });

  // Log state changes
  breaker.on('open', () => {
    logCircuitBreaker(name, 'OPEN', { reason: 'failure threshold exceeded' });
    updateCircuitBreakerState(name, 'OPEN');
  });

  breaker.on('halfOpen', () => {
    logCircuitBreaker(name, 'HALF_OPEN', { reason: 'reset timeout elapsed' });
    updateCircuitBreakerState(name, 'HALF_OPEN');
  });

  breaker.on('close', () => {
    logCircuitBreaker(name, 'CLOSED', { reason: 'service recovered' });
    updateCircuitBreakerState(name, 'CLOSED');
  });

  // Track failures and successes
  breaker.on('failure', (error) => {
    circuitBreakerFailures.inc({ name });
    logger.warn({ component: 'circuit_breaker', name, error: error.message }, 'Circuit breaker failure');
  });

  breaker.on('success', () => {
    circuitBreakerSuccesses.inc({ name });
  });

  // Log when requests are rejected due to open circuit
  breaker.on('reject', () => {
    logger.warn({ component: 'circuit_breaker', name }, 'Request rejected - circuit is open');
  });

  // Log timeouts
  breaker.on('timeout', () => {
    logger.warn({ component: 'circuit_breaker', name }, 'Request timed out');
  });

  // Initialize state metric
  updateCircuitBreakerState(name, 'CLOSED');

  // Store for health checks
  circuitBreakers.set(name, breaker);

  return breaker;
}

/**
 * Get all circuit breaker statuses for health check
 * @returns {object} Map of breaker names to their current status
 */
export function getCircuitBreakerStatus() {
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
 * Create Elasticsearch search circuit breaker
 */
let esSearchBreaker = null;

export function getElasticsearchSearchBreaker(searchFn) {
  if (!esSearchBreaker) {
    esSearchBreaker = createCircuitBreaker('elasticsearch_search', searchFn, {
      timeout: 3000, // 3 second timeout for search
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    });
  }
  return esSearchBreaker;
}

/**
 * Create Elasticsearch autocomplete circuit breaker
 */
let esAutocompleteBreaker = null;

export function getElasticsearchAutocompleteBreaker(autocompleteFn) {
  if (!esAutocompleteBreaker) {
    esAutocompleteBreaker = createCircuitBreaker('elasticsearch_autocomplete', autocompleteFn, {
      timeout: 2000, // 2 second timeout for autocomplete
      errorThresholdPercentage: 60,
      resetTimeout: 20000,
    });
  }
  return esAutocompleteBreaker;
}

/**
 * Create PostgreSQL geo query circuit breaker
 */
let pgGeoBreaker = null;

export function getPostgresGeoBreaker(geoQueryFn) {
  if (!pgGeoBreaker) {
    pgGeoBreaker = createCircuitBreaker('postgres_geo', geoQueryFn, {
      timeout: 5000, // 5 second timeout for geo queries
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    });
  }
  return pgGeoBreaker;
}

/**
 * Wrap a function with circuit breaker protection
 *
 * @param {string} name - Circuit breaker name
 * @param {Function} fn - Function to wrap
 * @param {object} options - Options
 * @returns {Function} - Wrapped function that uses circuit breaker
 */
export function withCircuitBreaker(name, fn, options = {}) {
  const breaker = createCircuitBreaker(name, fn, options);

  return async (...args) => {
    try {
      return await breaker.fire(...args);
    } catch (error) {
      if (error.message === 'Breaker is open') {
        // Circuit is open, provide fallback behavior
        throw new Error(`Service unavailable: ${name} circuit is open`);
      }
      throw error;
    }
  };
}

/**
 * Create a fallback handler for circuit breaker
 *
 * @param {string} name - Circuit breaker name
 * @param {Function} fallbackFn - Fallback function to call when circuit is open
 */
export function setFallback(breaker, fallbackFn) {
  breaker.fallback(fallbackFn);
}

export default {
  createCircuitBreaker,
  getCircuitBreakerStatus,
  getElasticsearchSearchBreaker,
  getElasticsearchAutocompleteBreaker,
  getPostgresGeoBreaker,
  withCircuitBreaker,
  setFallback,
};
