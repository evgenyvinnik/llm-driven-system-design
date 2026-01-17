import CircuitBreaker from 'opossum';
import logger from './logger.js';
import { circuitBreakerState, circuitBreakerFailures } from './metrics.js';

// Circuit breaker states for metrics
const STATE_CLOSED = 0;
const STATE_OPEN = 1;
const STATE_HALF_OPEN = 2;

// Default circuit breaker options
const defaultOptions = {
  timeout: 10000,           // 10 seconds timeout
  errorThresholdPercentage: 50,  // Open after 50% failures
  resetTimeout: 30000,      // Try again after 30 seconds
  volumeThreshold: 5,       // Minimum calls before tripping
};

// Store for all circuit breakers
const breakers = new Map();

/**
 * Create a circuit breaker for an async operation
 * @param {string} name - Name for the circuit breaker
 * @param {Function} fn - The async function to wrap
 * @param {Object} options - Circuit breaker options
 * @returns {CircuitBreaker}
 */
export function createCircuitBreaker(name, fn, options = {}) {
  const mergedOptions = { ...defaultOptions, ...options, name };
  const breaker = new CircuitBreaker(fn, mergedOptions);

  // Event handlers for logging and metrics
  breaker.on('success', (result) => {
    logger.debug({ breaker: name }, 'Circuit breaker call succeeded');
  });

  breaker.on('timeout', () => {
    logger.warn({ breaker: name }, 'Circuit breaker call timed out');
    circuitBreakerFailures.inc({ name });
  });

  breaker.on('reject', () => {
    logger.warn({ breaker: name }, 'Circuit breaker rejected call (circuit open)');
  });

  breaker.on('open', () => {
    logger.error({ breaker: name }, 'Circuit breaker opened');
    circuitBreakerState.set({ name }, STATE_OPEN);
  });

  breaker.on('halfOpen', () => {
    logger.info({ breaker: name }, 'Circuit breaker half-open, testing...');
    circuitBreakerState.set({ name }, STATE_HALF_OPEN);
  });

  breaker.on('close', () => {
    logger.info({ breaker: name }, 'Circuit breaker closed');
    circuitBreakerState.set({ name }, STATE_CLOSED);
  });

  breaker.on('fallback', (result) => {
    logger.info({ breaker: name }, 'Circuit breaker fallback executed');
  });

  breaker.on('failure', (error) => {
    logger.error({ breaker: name, error: error.message }, 'Circuit breaker call failed');
    circuitBreakerFailures.inc({ name });
  });

  // Initialize metrics
  circuitBreakerState.set({ name }, STATE_CLOSED);

  breakers.set(name, breaker);
  return breaker;
}

/**
 * Get circuit breaker by name
 * @param {string} name
 * @returns {CircuitBreaker|undefined}
 */
export function getCircuitBreaker(name) {
  return breakers.get(name);
}

/**
 * Get health status of all circuit breakers
 * @returns {Object}
 */
export function getCircuitBreakerHealth() {
  const status = {};
  for (const [name, breaker] of breakers) {
    status[name] = {
      state: breaker.opened ? 'open' : (breaker.halfOpen ? 'half-open' : 'closed'),
      stats: breaker.stats,
    };
  }
  return status;
}

/**
 * Execute function with circuit breaker, with fallback
 * @param {CircuitBreaker} breaker
 * @param {Array} args - Arguments to pass to the function
 * @param {Function} fallback - Fallback function if circuit is open
 */
export async function executeWithFallback(breaker, args, fallback) {
  return breaker.fire(...args).catch((err) => {
    if (fallback) {
      logger.warn({ error: err.message }, 'Executing fallback');
      return fallback(...args);
    }
    throw err;
  });
}

export default { createCircuitBreaker, getCircuitBreaker, getCircuitBreakerHealth, executeWithFallback };
