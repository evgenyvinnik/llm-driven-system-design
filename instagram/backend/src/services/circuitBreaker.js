import CircuitBreaker from 'opossum';
import logger, { logError } from './logger.js';
import { circuitBreakerState, circuitBreakerEvents } from './metrics.js';

/**
 * Circuit Breaker Factory
 *
 * Creates circuit breakers for protecting services from cascading failures.
 *
 * The circuit breaker pattern prevents an application from repeatedly
 * trying to execute an operation that's likely to fail, allowing it to:
 * - Continue without waiting for the fault to be fixed
 * - Detect whether the fault has been resolved
 *
 * States:
 * - CLOSED (0): Normal operation, requests flow through
 * - OPEN (1): Failures exceeded threshold, requests fail fast
 * - HALF-OPEN (2): Testing if the underlying service has recovered
 */

// Default circuit breaker options
const defaultOptions = {
  timeout: 10000, // 10 seconds - if function takes longer, trigger a failure
  errorThresholdPercentage: 50, // Open circuit if 50% of requests fail
  resetTimeout: 30000, // 30 seconds before trying again (half-open)
  volumeThreshold: 5, // Minimum number of requests before circuit can trip
  rollingCountTimeout: 10000, // Time in ms for the rolling stats window
  rollingCountBuckets: 10, // Number of buckets in the rolling window
};

/**
 * Create a circuit breaker for a function
 * @param {string} name - Name of the circuit breaker (for metrics/logging)
 * @param {Function} fn - The function to wrap
 * @param {Object} options - Circuit breaker options
 * @returns {CircuitBreaker} The circuit breaker instance
 */
export const createCircuitBreaker = (name, fn, options = {}) => {
  const breaker = new CircuitBreaker(fn, {
    ...defaultOptions,
    ...options,
    name,
  });

  // Track state changes for metrics
  const updateState = (state) => {
    circuitBreakerState.labels(name).set(state);
  };

  // Event handlers for metrics and logging
  breaker.on('success', () => {
    circuitBreakerEvents.labels(name, 'success').inc();
  });

  breaker.on('failure', (error) => {
    circuitBreakerEvents.labels(name, 'failure').inc();
    logger.warn({
      circuitBreaker: name,
      event: 'failure',
      error: error.message,
    }, `Circuit breaker ${name}: failure - ${error.message}`);
  });

  breaker.on('timeout', () => {
    circuitBreakerEvents.labels(name, 'timeout').inc();
    logger.warn({
      circuitBreaker: name,
      event: 'timeout',
    }, `Circuit breaker ${name}: timeout`);
  });

  breaker.on('reject', () => {
    circuitBreakerEvents.labels(name, 'reject').inc();
    logger.warn({
      circuitBreaker: name,
      event: 'reject',
    }, `Circuit breaker ${name}: rejected (circuit open)`);
  });

  breaker.on('open', () => {
    updateState(1); // OPEN
    circuitBreakerEvents.labels(name, 'open').inc();
    logger.error({
      circuitBreaker: name,
      event: 'open',
    }, `Circuit breaker ${name}: OPENED - too many failures`);
  });

  breaker.on('close', () => {
    updateState(0); // CLOSED
    circuitBreakerEvents.labels(name, 'close').inc();
    logger.info({
      circuitBreaker: name,
      event: 'close',
    }, `Circuit breaker ${name}: CLOSED - recovered`);
  });

  breaker.on('halfOpen', () => {
    updateState(2); // HALF-OPEN
    circuitBreakerEvents.labels(name, 'halfOpen').inc();
    logger.info({
      circuitBreaker: name,
      event: 'halfOpen',
    }, `Circuit breaker ${name}: HALF-OPEN - testing recovery`);
  });

  // Initialize state metric
  updateState(0);

  return breaker;
};

/**
 * Fallback function that returns a cached/default value
 * @param {*} defaultValue - Default value to return when circuit is open
 * @returns {Function} Fallback function
 */
export const fallbackWithDefault = (defaultValue) => {
  return (error) => {
    logger.warn({
      error: error?.message,
      fallback: 'default_value',
    }, 'Using fallback default value');
    return defaultValue;
  };
};

/**
 * Fallback function that throws a user-friendly error
 * @param {string} message - Error message for the user
 * @returns {Function} Fallback function
 */
export const fallbackWithError = (message) => {
  return (error) => {
    logger.error({
      originalError: error?.message,
      fallback: 'error',
    }, `Circuit breaker fallback: ${message}`);
    const serviceError = new Error(message);
    serviceError.statusCode = 503;
    serviceError.code = 'SERVICE_UNAVAILABLE';
    throw serviceError;
  };
};

/**
 * Health check for circuit breakers
 * @param {Object} breakers - Map of circuit breaker instances
 * @returns {Object} Health status of all circuit breakers
 */
export const getCircuitBreakerHealth = (breakers) => {
  const health = {};
  for (const [name, breaker] of Object.entries(breakers)) {
    const stats = breaker.stats;
    health[name] = {
      state: breaker.opened ? (breaker.halfOpen ? 'half-open' : 'open') : 'closed',
      failures: stats.failures,
      successes: stats.successes,
      timeouts: stats.timeouts,
      fallbacks: stats.fallbacks,
      latencyMean: stats.latencyMean?.toFixed(2),
    };
  }
  return health;
};

export default createCircuitBreaker;
