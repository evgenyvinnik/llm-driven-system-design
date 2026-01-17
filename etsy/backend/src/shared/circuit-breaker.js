import CircuitBreaker from 'opossum';
import { circuitBreakerState, circuitBreakerFailures } from './metrics.js';
import { createLogger } from './logger.js';

const logger = createLogger('circuit-breaker');

// Circuit breaker configuration presets
const CIRCUIT_CONFIGS = {
  // For payment services - very conservative, fail fast
  payment: {
    timeout: 5000,           // 5 second timeout
    errorThresholdPercentage: 25, // Open circuit after 25% failures
    resetTimeout: 30000,     // Wait 30 seconds before trying again
    volumeThreshold: 5,      // Minimum 5 requests before calculating error rate
  },
  // For search/Elasticsearch - more tolerant, can degrade gracefully
  search: {
    timeout: 3000,           // 3 second timeout
    errorThresholdPercentage: 50, // Open circuit after 50% failures
    resetTimeout: 15000,     // Wait 15 seconds before trying again
    volumeThreshold: 10,     // Minimum 10 requests
  },
  // For external APIs - moderate tolerance
  external: {
    timeout: 10000,          // 10 second timeout
    errorThresholdPercentage: 40,
    resetTimeout: 20000,
    volumeThreshold: 5,
  },
  // Default configuration
  default: {
    timeout: 5000,
    errorThresholdPercentage: 50,
    resetTimeout: 30000,
    volumeThreshold: 5,
  },
};

// Store all circuit breakers for monitoring
const breakers = new Map();

/**
 * Create a circuit breaker for a service
 * @param {string} name - Service name (for metrics and logging)
 * @param {Function} action - The async function to protect
 * @param {string} configPreset - Configuration preset name
 * @param {Object} fallbackFn - Optional fallback function when circuit is open
 * @returns {CircuitBreaker} Configured circuit breaker
 */
export function createCircuitBreaker(name, action, configPreset = 'default', fallbackFn = null) {
  const config = CIRCUIT_CONFIGS[configPreset] || CIRCUIT_CONFIGS.default;

  const breaker = new CircuitBreaker(action, {
    ...config,
    name,
  });

  // Set up event handlers for monitoring
  breaker.on('success', (result) => {
    logger.debug({ service: name }, 'Circuit breaker success');
  });

  breaker.on('timeout', () => {
    logger.warn({ service: name }, 'Circuit breaker timeout');
    circuitBreakerFailures.labels(name).inc();
  });

  breaker.on('reject', () => {
    logger.warn({ service: name }, 'Circuit breaker rejected (circuit open)');
  });

  breaker.on('open', () => {
    logger.error({ service: name }, 'Circuit breaker opened');
    circuitBreakerState.labels(name).set(1); // 1 = open
  });

  breaker.on('halfOpen', () => {
    logger.info({ service: name }, 'Circuit breaker half-open');
    circuitBreakerState.labels(name).set(2); // 2 = half-open
  });

  breaker.on('close', () => {
    logger.info({ service: name }, 'Circuit breaker closed');
    circuitBreakerState.labels(name).set(0); // 0 = closed
  });

  breaker.on('fallback', (result) => {
    logger.info({ service: name }, 'Circuit breaker fallback executed');
  });

  breaker.on('failure', (error) => {
    logger.error({ service: name, error: error.message }, 'Circuit breaker failure');
    circuitBreakerFailures.labels(name).inc();
  });

  // Set fallback if provided
  if (fallbackFn) {
    breaker.fallback(fallbackFn);
  }

  // Initialize state metric
  circuitBreakerState.labels(name).set(0);

  // Store breaker for monitoring
  breakers.set(name, breaker);

  return breaker;
}

/**
 * Get circuit breaker status for all services
 * @returns {Object} Status of all circuit breakers
 */
export function getCircuitBreakerStatus() {
  const status = {};
  for (const [name, breaker] of breakers) {
    status[name] = {
      state: breaker.opened ? 'open' : breaker.halfOpen ? 'half-open' : 'closed',
      stats: {
        successes: breaker.stats.successes,
        failures: breaker.stats.failures,
        timeouts: breaker.stats.timeouts,
        rejects: breaker.stats.rejects,
        fallbacks: breaker.stats.fallbacks,
      },
    };
  }
  return status;
}

/**
 * Force open a circuit breaker (for maintenance/testing)
 * @param {string} name - Service name
 */
export function forceOpen(name) {
  const breaker = breakers.get(name);
  if (breaker) {
    breaker.open();
    logger.warn({ service: name }, 'Circuit breaker force opened');
  }
}

/**
 * Force close a circuit breaker (for recovery)
 * @param {string} name - Service name
 */
export function forceClose(name) {
  const breaker = breakers.get(name);
  if (breaker) {
    breaker.close();
    logger.info({ service: name }, 'Circuit breaker force closed');
  }
}

// Pre-configured circuit breaker for search operations
export const searchCircuitBreaker = {
  breaker: null,

  /**
   * Initialize the search circuit breaker
   * @param {Function} searchFn - The search function to wrap
   * @param {Function} fallbackFn - Fallback when circuit is open
   */
  init(searchFn, fallbackFn) {
    this.breaker = createCircuitBreaker('elasticsearch', searchFn, 'search', fallbackFn);
  },

  /**
   * Execute a search through the circuit breaker
   * @param {...any} args - Arguments to pass to search function
   * @returns {Promise<any>} Search results or fallback
   */
  async fire(...args) {
    if (!this.breaker) {
      throw new Error('Search circuit breaker not initialized');
    }
    return this.breaker.fire(...args);
  },
};

// Pre-configured circuit breaker for payment operations
export const paymentCircuitBreaker = {
  breaker: null,

  /**
   * Initialize the payment circuit breaker
   * @param {Function} paymentFn - The payment processing function
   * @param {Function} fallbackFn - Fallback when circuit is open
   */
  init(paymentFn, fallbackFn) {
    this.breaker = createCircuitBreaker('payment', paymentFn, 'payment', fallbackFn);
  },

  /**
   * Execute a payment through the circuit breaker
   * @param {...any} args - Arguments to pass to payment function
   * @returns {Promise<any>} Payment result or fallback
   */
  async fire(...args) {
    if (!this.breaker) {
      throw new Error('Payment circuit breaker not initialized');
    }
    return this.breaker.fire(...args);
  },
};

export default {
  createCircuitBreaker,
  getCircuitBreakerStatus,
  forceOpen,
  forceClose,
  searchCircuitBreaker,
  paymentCircuitBreaker,
  CIRCUIT_CONFIGS,
};
