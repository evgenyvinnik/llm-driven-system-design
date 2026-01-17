import CircuitBreaker from 'opossum';
import { createLogger } from './logger.js';
import { metrics } from './metrics.js';

const logger = createLogger('circuit-breaker');

// Default options for circuit breakers
const DEFAULT_OPTIONS = {
  timeout: 5000, // 5 second timeout
  errorThresholdPercentage: 50, // Open after 50% failures
  resetTimeout: 30000, // Try again after 30 seconds
  volumeThreshold: 5, // Minimum 5 requests before tripping
};

// Store active circuit breakers for monitoring
const circuitBreakers = new Map();

/**
 * Create a circuit breaker for a given function
 * @param {Function} fn - The function to wrap
 * @param {string} name - Name for logging and metrics
 * @param {Object} options - Circuit breaker options
 * @returns {CircuitBreaker}
 */
export function createCircuitBreaker(fn, name, options = {}) {
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };

  const breaker = new CircuitBreaker(fn, mergedOptions);

  // Event handlers for logging and metrics
  breaker.on('open', () => {
    logger.warn({ circuit: name }, 'Circuit breaker OPENED - requests will be rejected');
    metrics.circuitBreakerState.set({ circuit: name, state: 'open' }, 1);
    metrics.circuitBreakerState.set({ circuit: name, state: 'closed' }, 0);
    metrics.circuitBreakerState.set({ circuit: name, state: 'half_open' }, 0);
  });

  breaker.on('halfOpen', () => {
    logger.info({ circuit: name }, 'Circuit breaker HALF-OPEN - testing with next request');
    metrics.circuitBreakerState.set({ circuit: name, state: 'open' }, 0);
    metrics.circuitBreakerState.set({ circuit: name, state: 'closed' }, 0);
    metrics.circuitBreakerState.set({ circuit: name, state: 'half_open' }, 1);
  });

  breaker.on('close', () => {
    logger.info({ circuit: name }, 'Circuit breaker CLOSED - normal operation resumed');
    metrics.circuitBreakerState.set({ circuit: name, state: 'open' }, 0);
    metrics.circuitBreakerState.set({ circuit: name, state: 'closed' }, 1);
    metrics.circuitBreakerState.set({ circuit: name, state: 'half_open' }, 0);
  });

  breaker.on('success', (result) => {
    metrics.circuitBreakerRequests.inc({ circuit: name, result: 'success' });
  });

  breaker.on('failure', (error) => {
    logger.error({ circuit: name, error: error.message }, 'Circuit breaker recorded failure');
    metrics.circuitBreakerRequests.inc({ circuit: name, result: 'failure' });
  });

  breaker.on('timeout', () => {
    logger.warn({ circuit: name }, 'Circuit breaker request timed out');
    metrics.circuitBreakerRequests.inc({ circuit: name, result: 'timeout' });
  });

  breaker.on('reject', () => {
    logger.warn({ circuit: name }, 'Circuit breaker rejected request (circuit open)');
    metrics.circuitBreakerRequests.inc({ circuit: name, result: 'rejected' });
  });

  breaker.on('fallback', (result) => {
    metrics.circuitBreakerRequests.inc({ circuit: name, result: 'fallback' });
  });

  // Initialize metrics
  metrics.circuitBreakerState.set({ circuit: name, state: 'closed' }, 1);
  metrics.circuitBreakerState.set({ circuit: name, state: 'open' }, 0);
  metrics.circuitBreakerState.set({ circuit: name, state: 'half_open' }, 0);

  circuitBreakers.set(name, breaker);

  return breaker;
}

/**
 * Get circuit breaker status for health checks
 * @returns {Object} Status of all circuit breakers
 */
export function getCircuitBreakerStatus() {
  const status = {};

  for (const [name, breaker] of circuitBreakers) {
    status[name] = {
      state: breaker.opened ? 'open' : breaker.halfOpen ? 'half-open' : 'closed',
      stats: {
        successes: breaker.stats.successes,
        failures: breaker.stats.failures,
        rejects: breaker.stats.rejects,
        timeouts: breaker.stats.timeouts,
        fallbacks: breaker.stats.fallbacks,
      },
    };
  }

  return status;
}

/**
 * Create circuit breaker with fallback
 * @param {Function} fn - The function to wrap
 * @param {string} name - Name for logging and metrics
 * @param {Function} fallbackFn - Fallback function when circuit is open
 * @param {Object} options - Circuit breaker options
 * @returns {CircuitBreaker}
 */
export function createCircuitBreakerWithFallback(fn, name, fallbackFn, options = {}) {
  const breaker = createCircuitBreaker(fn, name, options);
  breaker.fallback(fallbackFn);
  return breaker;
}

/**
 * Retry wrapper with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {Object} options - Retry options
 * @returns {Promise} Result of the function
 */
export async function withRetry(fn, options = {}) {
  const {
    maxRetries = 3,
    baseDelay = 100, // 100ms base delay
    maxDelay = 5000, // 5 second max delay
    retryOn = (error) => true, // Retry on all errors by default
    onRetry = null,
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries || !retryOn(error)) {
        throw error;
      }

      // Exponential backoff with jitter
      const delay = Math.min(
        baseDelay * Math.pow(2, attempt) + Math.random() * 100,
        maxDelay
      );

      if (onRetry) {
        onRetry(attempt + 1, delay, error);
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

export default { createCircuitBreaker, createCircuitBreakerWithFallback, withRetry, getCircuitBreakerStatus };
