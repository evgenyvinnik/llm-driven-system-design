/**
 * Circuit Breaker Pattern Implementation
 *
 * WHY: Circuit breakers prevent cascading failures by:
 * - Failing fast when downstream services are unhealthy
 * - Giving downstream services time to recover
 * - Providing fallback behavior for degraded operation
 * - Protecting against thundering herd on recovery
 */

const CircuitBreaker = require('opossum');
const { logger } = require('./logger');
const metrics = require('./metrics');

// Default circuit breaker options
const DEFAULT_OPTIONS = {
  timeout: 5000, // 5 seconds
  errorThresholdPercentage: 50, // Open circuit after 50% failures
  resetTimeout: 30000, // Try again after 30 seconds
  volumeThreshold: 5, // Minimum requests before tripping
};

// Circuit breaker state mapping for metrics
const STATE_MAP = {
  closed: 0,
  halfOpen: 1,
  open: 2,
};

/**
 * Create a circuit breaker for a service
 * @param {string} name - Service name for logging and metrics
 * @param {Function} fn - The function to wrap
 * @param {Object} options - Circuit breaker options
 * @param {Function} fallback - Optional fallback function
 * @returns {CircuitBreaker}
 */
function createCircuitBreaker(name, fn, options = {}, fallback = null) {
  const breaker = new CircuitBreaker(fn, {
    ...DEFAULT_OPTIONS,
    ...options,
    name,
  });

  // Set up event handlers for logging and metrics
  breaker.on('success', () => {
    logger.debug({ service: name }, 'Circuit breaker call succeeded');
  });

  breaker.on('timeout', () => {
    logger.warn({ service: name }, 'Circuit breaker call timed out');
    metrics.circuitBreakerFailuresTotal.inc({ service: name });
  });

  breaker.on('reject', () => {
    logger.warn({ service: name }, 'Circuit breaker rejected call (circuit open)');
    metrics.circuitBreakerFailuresTotal.inc({ service: name });
  });

  breaker.on('open', () => {
    logger.error({ service: name }, 'Circuit breaker opened');
    metrics.circuitBreakerState.set({ service: name }, STATE_MAP.open);
  });

  breaker.on('halfOpen', () => {
    logger.info({ service: name }, 'Circuit breaker half-opened');
    metrics.circuitBreakerState.set({ service: name }, STATE_MAP.halfOpen);
  });

  breaker.on('close', () => {
    logger.info({ service: name }, 'Circuit breaker closed');
    metrics.circuitBreakerState.set({ service: name }, STATE_MAP.closed);
  });

  breaker.on('fallback', () => {
    logger.info({ service: name }, 'Circuit breaker fallback executed');
  });

  // Initialize state metric
  metrics.circuitBreakerState.set({ service: name }, STATE_MAP.closed);

  // Set fallback if provided
  if (fallback) {
    breaker.fallback(fallback);
  }

  return breaker;
}

/**
 * Wrap an async function with circuit breaker
 * @param {string} name - Service name
 * @param {Function} fn - Async function to wrap
 * @param {Object} options - Options
 * @returns {Function} Wrapped function
 */
function withCircuitBreaker(name, fn, options = {}) {
  const breaker = createCircuitBreaker(name, fn, options);

  return async (...args) => {
    return breaker.fire(...args);
  };
}

// ============================================
// Pre-configured Circuit Breakers for Services
// ============================================

/**
 * Payment service circuit breaker
 * More conservative settings due to financial impact
 */
const paymentCircuitBreakerOptions = {
  timeout: 10000, // 10 seconds - payments can be slow
  errorThresholdPercentage: 30, // Open at 30% failures
  resetTimeout: 60000, // Wait 60 seconds before retry
  volumeThreshold: 3, // Trip after 3 failed requests
};

/**
 * Create a payment service circuit breaker
 */
function createPaymentCircuitBreaker(paymentFn) {
  return createCircuitBreaker(
    'payment-service',
    paymentFn,
    paymentCircuitBreakerOptions,
    // Fallback: queue payment for later processing
    async (bookingId, amount) => {
      logger.warn(
        { bookingId, amount },
        'Payment service unavailable, queueing for later'
      );
      return {
        success: false,
        queued: true,
        message: 'Payment queued for processing',
      };
    }
  );
}

/**
 * Availability service circuit breaker
 * Used for external availability APIs if integrated
 */
const availabilityCircuitBreakerOptions = {
  timeout: 3000, // 3 seconds
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
  volumeThreshold: 5,
};

/**
 * Create an availability check circuit breaker
 */
function createAvailabilityCircuitBreaker(availabilityFn) {
  return createCircuitBreaker(
    'availability-service',
    availabilityFn,
    availabilityCircuitBreakerOptions,
    // Fallback: return cached or pessimistic response
    async (hotelId, roomTypeId, checkIn, checkOut) => {
      logger.warn(
        { hotelId, roomTypeId, checkIn, checkOut },
        'Availability service unavailable, returning unavailable'
      );
      return {
        available: false,
        fallback: true,
        message: 'Unable to check availability, please try again',
      };
    }
  );
}

/**
 * Elasticsearch circuit breaker
 */
const elasticsearchCircuitBreakerOptions = {
  timeout: 5000,
  errorThresholdPercentage: 50,
  resetTimeout: 20000,
  volumeThreshold: 5,
};

/**
 * Create an Elasticsearch circuit breaker
 */
function createElasticsearchCircuitBreaker(searchFn, fallbackFn = null) {
  return createCircuitBreaker(
    'elasticsearch',
    searchFn,
    elasticsearchCircuitBreakerOptions,
    fallbackFn
  );
}

module.exports = {
  createCircuitBreaker,
  withCircuitBreaker,
  createPaymentCircuitBreaker,
  createAvailabilityCircuitBreaker,
  createElasticsearchCircuitBreaker,
  DEFAULT_OPTIONS,
};
