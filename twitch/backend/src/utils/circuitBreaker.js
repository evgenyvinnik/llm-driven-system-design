/**
 * Circuit Breaker Implementation using Opossum
 *
 * Protects services from cascading failures by:
 * - Tracking failure rates for external calls
 * - Opening the circuit when failures exceed threshold
 * - Allowing gradual recovery via half-open state
 *
 * Use cases:
 * - Stream ingest service calls
 * - Chat message publishing to Redis
 * - Database queries during high load
 */
const CircuitBreaker = require('opossum');
const { logger } = require('./logger');
const { setCircuitBreakerState, incCircuitBreakerFailure } = require('./metrics');

// Default options for circuit breakers
const DEFAULT_OPTIONS = {
  timeout: 3000,              // Max time to wait for action to complete
  errorThresholdPercentage: 50, // Error percentage at which to open circuit
  resetTimeout: 10000,        // Time to wait before entering half-open state
  volumeThreshold: 5,         // Minimum requests before calculating error rate
  rollingCountTimeout: 10000, // Time window for counting requests
  rollingCountBuckets: 10     // Number of buckets in the rolling window
};

// Store all created circuit breakers for monitoring
const circuitBreakers = new Map();

/**
 * Create a circuit breaker for an async function
 * @param {string} name - Unique name for this circuit breaker
 * @param {Function} fn - Async function to wrap
 * @param {Object} options - Circuit breaker options (overrides defaults)
 * @returns {CircuitBreaker}
 */
function createCircuitBreaker(name, fn, options = {}) {
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };
  const breaker = new CircuitBreaker(fn, mergedOptions);

  // Log and update metrics on state changes
  breaker.on('open', () => {
    logger.error({ circuit: name }, 'Circuit breaker OPENED - calls will fail fast');
    setCircuitBreakerState(name, 'open');
  });

  breaker.on('halfOpen', () => {
    logger.warn({ circuit: name }, 'Circuit breaker HALF-OPEN - testing with next request');
    setCircuitBreakerState(name, 'halfOpen');
  });

  breaker.on('close', () => {
    logger.info({ circuit: name }, 'Circuit breaker CLOSED - normal operation resumed');
    setCircuitBreakerState(name, 'closed');
  });

  breaker.on('failure', (error) => {
    logger.warn({ circuit: name, error: error.message }, 'Circuit breaker recorded failure');
    incCircuitBreakerFailure(name);
  });

  breaker.on('timeout', () => {
    logger.warn({ circuit: name }, 'Circuit breaker request timed out');
  });

  breaker.on('reject', () => {
    logger.warn({ circuit: name }, 'Circuit breaker rejected request (circuit open)');
  });

  breaker.on('fallback', (result) => {
    logger.info({ circuit: name }, 'Circuit breaker fallback executed');
  });

  // Store for monitoring
  circuitBreakers.set(name, breaker);

  // Initialize metrics
  setCircuitBreakerState(name, 'closed');

  return breaker;
}

/**
 * Get statistics for all circuit breakers
 * @returns {Object} Map of circuit breaker names to their stats
 */
function getCircuitBreakerStats() {
  const stats = {};
  circuitBreakers.forEach((breaker, name) => {
    stats[name] = {
      state: breaker.opened ? 'open' : (breaker.halfOpen ? 'halfOpen' : 'closed'),
      stats: breaker.stats
    };
  });
  return stats;
}

/**
 * Get a specific circuit breaker by name
 * @param {string} name - Circuit breaker name
 * @returns {CircuitBreaker|undefined}
 */
function getCircuitBreaker(name) {
  return circuitBreakers.get(name);
}

// ===================
// Pre-configured Circuit Breakers
// ===================

/**
 * Circuit breaker for Redis pub/sub operations
 * - Shorter timeout since Redis should be fast
 * - Higher volume threshold for chat traffic
 */
function createRedisChatBreaker(redisPublishFn) {
  return createCircuitBreaker('redis-chat', redisPublishFn, {
    timeout: 1000,
    volumeThreshold: 10,
    resetTimeout: 5000
  });
}

/**
 * Circuit breaker for stream ingest operations
 * - Longer timeout for video operations
 * - Lower error threshold (streams are critical)
 */
function createStreamIngestBreaker(ingestFn) {
  return createCircuitBreaker('stream-ingest', ingestFn, {
    timeout: 5000,
    errorThresholdPercentage: 30,
    resetTimeout: 15000
  });
}

/**
 * Circuit breaker for database operations
 * - Medium timeout
 * - Standard thresholds
 */
function createDatabaseBreaker(dbFn) {
  return createCircuitBreaker('database', dbFn, {
    timeout: 3000,
    volumeThreshold: 5,
    resetTimeout: 10000
  });
}

/**
 * Wrap an async function with circuit breaker protection
 * Falls back to a provided fallback function or throws
 *
 * @param {string} name - Circuit breaker name
 * @param {Function} fn - Function to wrap
 * @param {Object} options - Circuit breaker options
 * @param {Function} fallback - Optional fallback function
 * @returns {Function} Wrapped function
 */
function withCircuitBreaker(name, fn, options = {}, fallback = null) {
  const breaker = createCircuitBreaker(name, fn, options);

  if (fallback) {
    breaker.fallback(fallback);
  }

  return async (...args) => {
    return breaker.fire(...args);
  };
}

module.exports = {
  createCircuitBreaker,
  getCircuitBreakerStats,
  getCircuitBreaker,
  createRedisChatBreaker,
  createStreamIngestBreaker,
  createDatabaseBreaker,
  withCircuitBreaker,
  DEFAULT_OPTIONS
};
