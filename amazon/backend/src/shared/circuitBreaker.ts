/**
 * Circuit Breaker Implementation using Opossum
 *
 * Provides resilience for external service calls (payment, inventory, search).
 * Prevents cascade failures by "opening" the circuit when failures exceed threshold.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Circuit tripped, requests fail fast without calling service
 * - HALF-OPEN: Testing if service recovered, limited requests allowed
 */
import CircuitBreaker from 'opossum';
import logger, { LogEvents } from './logger.js';
import { circuitBreakerState, circuitBreakerTripsTotal } from './metrics.js';

// Default circuit breaker options
const DEFAULT_OPTIONS = {
  timeout: 10000,           // 10 seconds - if function takes longer, trip
  errorThresholdPercentage: 50,  // Trip when 50% of requests fail
  resetTimeout: 30000,      // Try again after 30 seconds
  volumeThreshold: 5,       // Minimum requests before tripping
  rollingCountTimeout: 10000,  // Window for counting failures
  rollingCountBuckets: 10   // Number of buckets in the window
};

// Store circuit breakers by name
const breakers = new Map();

// Map opossum state to metric value
const stateToMetricValue = {
  closed: 0,
  halfOpen: 1,
  open: 2
};

/**
 * Create or get a circuit breaker for a service
 * @param {string} name - Service name
 * @param {Function} fn - Async function to wrap
 * @param {Object} options - Circuit breaker options
 * @returns {Function} Wrapped function with circuit breaker
 */
export function createCircuitBreaker(name, fn, options = {}) {
  if (breakers.has(name)) {
    return breakers.get(name);
  }

  const breaker = new CircuitBreaker(fn, {
    ...DEFAULT_OPTIONS,
    ...options,
    name
  });

  // Event handlers for logging and metrics
  breaker.on('open', () => {
    logger.warn({ service: name, event: LogEvents.CIRCUIT_OPENED }, `Circuit breaker OPENED for ${name}`);
    circuitBreakerState.set({ service: name }, stateToMetricValue.open);
    circuitBreakerTripsTotal.inc({ service: name });
  });

  breaker.on('close', () => {
    logger.info({ service: name, event: LogEvents.CIRCUIT_CLOSED }, `Circuit breaker CLOSED for ${name}`);
    circuitBreakerState.set({ service: name }, stateToMetricValue.closed);
  });

  breaker.on('halfOpen', () => {
    logger.info({ service: name, event: LogEvents.CIRCUIT_HALF_OPEN }, `Circuit breaker HALF-OPEN for ${name}`);
    circuitBreakerState.set({ service: name }, stateToMetricValue.halfOpen);
  });

  breaker.on('fallback', (result) => {
    logger.debug({ service: name, result }, `Circuit breaker fallback executed for ${name}`);
  });

  breaker.on('timeout', () => {
    logger.warn({ service: name }, `Circuit breaker timeout for ${name}`);
  });

  breaker.on('reject', () => {
    logger.warn({ service: name }, `Circuit breaker rejected request for ${name}`);
  });

  breaker.on('failure', (error) => {
    logger.error({ service: name, error: error.message }, `Circuit breaker recorded failure for ${name}`);
  });

  // Initialize metric
  circuitBreakerState.set({ service: name }, stateToMetricValue.closed);

  breakers.set(name, breaker);
  return breaker;
}

/**
 * Get circuit breaker stats
 * @param {string} name - Service name
 * @returns {Object} Circuit breaker statistics
 */
export function getCircuitBreakerStats(name) {
  const breaker = breakers.get(name);
  if (!breaker) {
    return null;
  }

  return {
    name,
    state: breaker.opened ? 'open' : (breaker.halfOpen ? 'halfOpen' : 'closed'),
    stats: breaker.stats,
    options: {
      timeout: breaker.options.timeout,
      errorThresholdPercentage: breaker.options.errorThresholdPercentage,
      resetTimeout: breaker.options.resetTimeout
    }
  };
}

/**
 * Get all circuit breaker stats
 * @returns {Object[]} Array of circuit breaker statistics
 */
export function getAllCircuitBreakerStats() {
  const stats = [];
  for (const [name, breaker] of breakers) {
    stats.push(getCircuitBreakerStats(name));
  }
  return stats;
}

// ============================================================
// Pre-configured Circuit Breakers for Common Services
// ============================================================

/**
 * Payment Gateway Circuit Breaker
 * More conservative settings - payment is critical
 */
export const paymentCircuitBreakerOptions = {
  timeout: 30000,           // Payment can take longer
  errorThresholdPercentage: 30,  // Trip faster for payment
  resetTimeout: 60000,      // Wait longer before retrying
  volumeThreshold: 3        // Trip after fewer failures
};

/**
 * Inventory Service Circuit Breaker
 */
export const inventoryCircuitBreakerOptions = {
  timeout: 5000,            // Inventory should be fast
  errorThresholdPercentage: 50,
  resetTimeout: 15000,
  volumeThreshold: 5
};

/**
 * Elasticsearch Circuit Breaker
 * Less critical - can fallback to PostgreSQL
 */
export const searchCircuitBreakerOptions = {
  timeout: 5000,
  errorThresholdPercentage: 60,  // More tolerant
  resetTimeout: 10000,
  volumeThreshold: 10
};

/**
 * Create a payment circuit breaker wrapper
 * @param {Function} paymentFn - Payment processing function
 * @param {Function} fallbackFn - Fallback function when circuit is open
 * @returns {CircuitBreaker} Configured circuit breaker
 */
export function createPaymentCircuitBreaker(paymentFn, fallbackFn = null) {
  const breaker = createCircuitBreaker('payment-gateway', paymentFn, paymentCircuitBreakerOptions);

  if (fallbackFn) {
    breaker.fallback(fallbackFn);
  }

  return breaker;
}

/**
 * Create an inventory circuit breaker wrapper
 * @param {Function} inventoryFn - Inventory check function
 * @param {Function} fallbackFn - Fallback function when circuit is open
 * @returns {CircuitBreaker} Configured circuit breaker
 */
export function createInventoryCircuitBreaker(inventoryFn, fallbackFn = null) {
  const breaker = createCircuitBreaker('inventory-service', inventoryFn, inventoryCircuitBreakerOptions);

  if (fallbackFn) {
    breaker.fallback(fallbackFn);
  }

  return breaker;
}

/**
 * Create a search circuit breaker wrapper
 * @param {Function} searchFn - Elasticsearch search function
 * @param {Function} fallbackFn - Fallback function (PostgreSQL search)
 * @returns {CircuitBreaker} Configured circuit breaker
 */
export function createSearchCircuitBreaker(searchFn, fallbackFn = null) {
  const breaker = createCircuitBreaker('elasticsearch', searchFn, searchCircuitBreakerOptions);

  if (fallbackFn) {
    breaker.fallback(fallbackFn);
  }

  return breaker;
}

/**
 * Check if a circuit breaker is open
 * @param {string} name - Service name
 * @returns {boolean} True if circuit is open
 */
export function isCircuitOpen(name) {
  const breaker = breakers.get(name);
  return breaker ? breaker.opened : false;
}

/**
 * Force close a circuit breaker (for testing/recovery)
 * @param {string} name - Service name
 */
export function forceCloseCircuit(name) {
  const breaker = breakers.get(name);
  if (breaker) {
    breaker.close();
    logger.info({ service: name }, `Circuit breaker force closed for ${name}`);
  }
}

/**
 * Force open a circuit breaker (for testing/maintenance)
 * @param {string} name - Service name
 */
export function forceOpenCircuit(name) {
  const breaker = breakers.get(name);
  if (breaker) {
    breaker.open();
    logger.info({ service: name }, `Circuit breaker force opened for ${name}`);
  }
}

export default {
  createCircuitBreaker,
  createPaymentCircuitBreaker,
  createInventoryCircuitBreaker,
  createSearchCircuitBreaker,
  getCircuitBreakerStats,
  getAllCircuitBreakerStats,
  isCircuitOpen,
  forceCloseCircuit,
  forceOpenCircuit
};
