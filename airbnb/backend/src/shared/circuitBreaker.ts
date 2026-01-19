/**
 * Circuit Breaker Module using Opossum
 *
 * Circuit breakers prevent cascading failures by:
 * - Tracking failure rates for external service calls
 * - Opening the circuit when failures exceed threshold
 * - Failing fast while circuit is open (returning fallback)
 * - Periodically testing if service has recovered (half-open state)
 *
 * States:
 * - CLOSED: Normal operation, requests go through
 * - OPEN: Service is failing, requests fail immediately
 * - HALF-OPEN: Testing if service has recovered
 *
 * Use for:
 * - Database queries (search, availability checks)
 * - External service calls (payment, notifications)
 * - Redis cache operations
 */

import CircuitBreaker from 'opossum';
import { metrics } from './metrics.js';
import { createModuleLogger } from './logger.js';

const log = createModuleLogger('circuit-breaker');

// Circuit breaker state constants for metrics
const CIRCUIT_STATES = {
  CLOSED: 0,
  OPEN: 1,
  HALF_OPEN: 2,
};

// Default options for circuit breakers
const defaultOptions = {
  timeout: 10000,           // 10 seconds timeout for each request
  errorThresholdPercentage: 50, // Open circuit if 50% of requests fail
  resetTimeout: 30000,      // Try again after 30 seconds
  volumeThreshold: 5,       // Minimum requests before tripping
  rollingCountTimeout: 10000, // Track stats over 10 seconds
  rollingCountBuckets: 10,  // 10 buckets of 1 second each
};

// Store for all circuit breakers
const circuitBreakers = new Map();

/**
 * Create or get a circuit breaker for a service
 * @param {string} name - Service name for identification
 * @param {Function} fn - The function to wrap with circuit breaker
 * @param {object} options - Circuit breaker options
 * @param {Function} fallback - Fallback function when circuit is open
 */
export function createCircuitBreaker(name, fn, options = {}, fallback = null) {
  if (circuitBreakers.has(name)) {
    return circuitBreakers.get(name);
  }

  const breaker = new CircuitBreaker(fn, {
    ...defaultOptions,
    ...options,
    name,
  });

  // Set up event handlers for monitoring

  breaker.on('success', (result, latencyMs) => {
    metrics.circuitBreakerSuccesses.inc({ service: name });
    log.debug({ service: name, latencyMs }, 'Circuit breaker success');
  });

  breaker.on('failure', (error, latencyMs) => {
    metrics.circuitBreakerFailures.inc({ service: name });
    log.warn({ service: name, error: error.message, latencyMs }, 'Circuit breaker failure');
  });

  breaker.on('timeout', () => {
    metrics.circuitBreakerFailures.inc({ service: name });
    log.warn({ service: name }, 'Circuit breaker timeout');
  });

  breaker.on('reject', () => {
    log.warn({ service: name }, 'Circuit breaker rejected (circuit open)');
  });

  breaker.on('open', () => {
    metrics.circuitBreakerState.set({ service: name }, CIRCUIT_STATES.OPEN);
    log.error({ service: name }, 'Circuit breaker OPENED');
  });

  breaker.on('halfOpen', () => {
    metrics.circuitBreakerState.set({ service: name }, CIRCUIT_STATES.HALF_OPEN);
    log.info({ service: name }, 'Circuit breaker HALF-OPEN (testing)');
  });

  breaker.on('close', () => {
    metrics.circuitBreakerState.set({ service: name }, CIRCUIT_STATES.CLOSED);
    log.info({ service: name }, 'Circuit breaker CLOSED (recovered)');
  });

  // Set fallback if provided
  if (fallback) {
    breaker.fallback(fallback);
  }

  // Initialize metric
  metrics.circuitBreakerState.set({ service: name }, CIRCUIT_STATES.CLOSED);

  circuitBreakers.set(name, breaker);
  return breaker;
}

/**
 * Get an existing circuit breaker
 */
export function getCircuitBreaker(name) {
  return circuitBreakers.get(name);
}

/**
 * Get status of all circuit breakers
 */
export function getAllCircuitBreakersStatus() {
  const status = {};
  for (const [name, breaker] of circuitBreakers) {
    status[name] = {
      state: breaker.opened ? 'OPEN' : (breaker.halfOpen ? 'HALF_OPEN' : 'CLOSED'),
      stats: breaker.stats,
    };
  }
  return status;
}

// Pre-configured circuit breakers for common services

/**
 * Circuit breaker for search operations
 * More tolerant of failures since search can return cached/stale results
 */
export function createSearchCircuitBreaker(searchFn) {
  return createCircuitBreaker(
    'search',
    searchFn,
    {
      timeout: 5000,              // 5 second timeout
      errorThresholdPercentage: 60, // More tolerant
      resetTimeout: 20000,         // Try again after 20 seconds
    },
    // Fallback: return empty results
    async () => {
      log.warn('Search circuit breaker fallback - returning empty results');
      return { listings: [], total: 0, fromFallback: true };
    }
  );
}

/**
 * Circuit breaker for availability checks
 * Critical operation - needs to fail fast
 */
export function createAvailabilityCircuitBreaker(checkFn) {
  return createCircuitBreaker(
    'availability',
    checkFn,
    {
      timeout: 3000,              // 3 second timeout
      errorThresholdPercentage: 40, // Less tolerant
      resetTimeout: 15000,         // Try again after 15 seconds
    },
    // Fallback: assume unavailable (safe default)
    async () => {
      log.warn('Availability circuit breaker fallback - assuming unavailable');
      return { available: false, fromFallback: true, error: 'Service temporarily unavailable' };
    }
  );
}

/**
 * Circuit breaker for database operations
 */
export function createDatabaseCircuitBreaker(name, dbFn) {
  return createCircuitBreaker(
    `db-${name}`,
    dbFn,
    {
      timeout: 10000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    },
    null // No fallback for DB - let it fail
  );
}

/**
 * Circuit breaker for external notification service
 */
export function createNotificationCircuitBreaker(notifyFn) {
  return createCircuitBreaker(
    'notification',
    notifyFn,
    {
      timeout: 15000,             // 15 second timeout for external service
      errorThresholdPercentage: 70, // Very tolerant
      resetTimeout: 60000,         // Wait longer before retry
    },
    // Fallback: queue for later
    async (notification) => {
      log.warn({ notification }, 'Notification circuit breaker fallback - queuing for later');
      return { queued: true, error: 'Notification service unavailable' };
    }
  );
}

/**
 * Wrap an async function with a circuit breaker
 * Convenience function for one-off protection
 */
export function withCircuitBreaker(name, fn, options = {}, fallback = null) {
  const breaker = createCircuitBreaker(name, fn, options, fallback);
  return (...args) => breaker.fire(...args);
}

/**
 * Health check for circuit breakers
 * Returns true if all critical circuit breakers are closed
 */
export function checkCircuitBreakersHealth() {
  const criticalBreakers = ['availability', 'db-bookings'];
  for (const name of criticalBreakers) {
    const breaker = circuitBreakers.get(name);
    if (breaker && breaker.opened) {
      return {
        healthy: false,
        openCircuits: [name],
      };
    }
  }
  return { healthy: true, openCircuits: [] };
}

export default {
  createCircuitBreaker,
  getCircuitBreaker,
  getAllCircuitBreakersStatus,
  createSearchCircuitBreaker,
  createAvailabilityCircuitBreaker,
  createDatabaseCircuitBreaker,
  createNotificationCircuitBreaker,
  withCircuitBreaker,
  checkCircuitBreakersHealth,
};
