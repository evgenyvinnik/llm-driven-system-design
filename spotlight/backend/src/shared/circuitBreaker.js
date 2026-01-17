import CircuitBreaker from 'opossum';
import { circuitBreakerState, circuitBreakerTripsTotal } from './metrics.js';
import { logCircuitBreakerState } from './logger.js';

// Circuit breaker state mapping for metrics
const STATE_MAP = {
  'closed': 0,
  'halfOpen': 1,
  'open': 2
};

/**
 * Default circuit breaker configuration for index operations
 * - Opens after 5 consecutive failures
 * - Waits 30 seconds before allowing test requests
 * - Requires 3 successful requests to close
 */
const DEFAULT_INDEX_OPTIONS = {
  timeout: 10000,           // 10 seconds timeout for index operations
  errorThresholdPercentage: 50,  // Open if 50% of requests fail
  resetTimeout: 30000,      // Wait 30 seconds before half-open
  volumeThreshold: 5,       // Minimum 5 requests before calculating error percentage
  rollingCountTimeout: 10000,    // Rolling window of 10 seconds
  rollingCountBuckets: 10   // 10 buckets for rolling statistics
};

/**
 * Circuit breaker configuration for Elasticsearch operations
 * More aggressive than default since ES failures affect search quality
 */
const ES_OPTIONS = {
  timeout: 5000,            // 5 seconds timeout
  errorThresholdPercentage: 30,  // Open if 30% of requests fail
  resetTimeout: 60000,      // Wait 60 seconds before half-open
  volumeThreshold: 3,       // Only need 3 failures
  rollingCountTimeout: 10000,
  rollingCountBuckets: 10
};

// Map to store circuit breakers by name
const circuitBreakers = new Map();

/**
 * Create or get a circuit breaker for a specific operation
 * @param {string} name - Name of the circuit breaker
 * @param {Function} action - The async function to protect
 * @param {Object} options - Circuit breaker options
 * @returns {CircuitBreaker} - The circuit breaker instance
 */
export function createCircuitBreaker(name, action, options = {}) {
  if (circuitBreakers.has(name)) {
    return circuitBreakers.get(name);
  }

  const mergedOptions = {
    ...DEFAULT_INDEX_OPTIONS,
    ...options,
    name
  };

  const breaker = new CircuitBreaker(action, mergedOptions);

  // Set up event handlers for monitoring
  breaker.on('open', () => {
    circuitBreakerState.labels(name).set(STATE_MAP.open);
    circuitBreakerTripsTotal.labels(name).inc();
    logCircuitBreakerState({ name, state: 'OPEN', failures: breaker.stats.failures });
  });

  breaker.on('halfOpen', () => {
    circuitBreakerState.labels(name).set(STATE_MAP.halfOpen);
    logCircuitBreakerState({ name, state: 'HALF_OPEN', failures: breaker.stats.failures });
  });

  breaker.on('close', () => {
    circuitBreakerState.labels(name).set(STATE_MAP.closed);
    logCircuitBreakerState({ name, state: 'CLOSED', failures: 0 });
  });

  breaker.on('timeout', () => {
    logCircuitBreakerState({ name, state: 'TIMEOUT', failures: breaker.stats.failures });
  });

  breaker.on('reject', () => {
    logCircuitBreakerState({ name, state: 'REJECTED', failures: breaker.stats.failures });
  });

  // Initialize metrics
  circuitBreakerState.labels(name).set(STATE_MAP.closed);

  circuitBreakers.set(name, breaker);
  return breaker;
}

/**
 * Create a circuit breaker specifically for Elasticsearch index operations
 * @param {string} indexName - Name of the Elasticsearch index
 * @param {Function} action - The async function to protect
 * @returns {CircuitBreaker} - The circuit breaker instance
 */
export function createIndexCircuitBreaker(indexName, action) {
  return createCircuitBreaker(`es_index_${indexName}`, action, ES_OPTIONS);
}

/**
 * Execute an operation with circuit breaker protection
 * @param {string} breakerName - Name of the circuit breaker
 * @param {Function} action - The async function to execute
 * @param {*} fallbackValue - Value to return if circuit is open
 * @returns {Promise<*>} - Result of the action or fallback
 */
export async function withCircuitBreaker(breakerName, action, fallbackValue = null) {
  let breaker = circuitBreakers.get(breakerName);

  if (!breaker) {
    breaker = createCircuitBreaker(breakerName, action);
  }

  try {
    // For dynamic actions, we need to fire with the action
    return await breaker.fire();
  } catch (error) {
    if (error.code === 'EOPENBREAKER') {
      // Circuit is open, return fallback
      return fallbackValue;
    }
    throw error;
  }
}

/**
 * Get the current state of all circuit breakers
 * @returns {Object} - Map of circuit breaker names to their states
 */
export function getAllCircuitBreakerStates() {
  const states = {};
  for (const [name, breaker] of circuitBreakers) {
    states[name] = {
      state: breaker.opened ? 'OPEN' : (breaker.halfOpen ? 'HALF_OPEN' : 'CLOSED'),
      stats: {
        failures: breaker.stats.failures,
        successes: breaker.stats.successes,
        rejects: breaker.stats.rejects,
        timeouts: breaker.stats.timeouts
      }
    };
  }
  return states;
}

/**
 * Get a specific circuit breaker by name
 * @param {string} name - Name of the circuit breaker
 * @returns {CircuitBreaker|undefined} - The circuit breaker or undefined
 */
export function getCircuitBreaker(name) {
  return circuitBreakers.get(name);
}

/**
 * Wrapper class for index operations with built-in circuit breaker
 */
export class ProtectedIndexOperation {
  constructor(name, options = {}) {
    this.name = name;
    this.options = { ...ES_OPTIONS, ...options };
    this.breaker = null;
  }

  /**
   * Execute an index operation with circuit breaker protection
   * @param {Function} operation - The async function to execute
   * @returns {Promise<*>} - Result of the operation
   */
  async execute(operation) {
    if (!this.breaker) {
      this.breaker = createCircuitBreaker(this.name, operation, this.options);
    }

    return this.breaker.fire();
  }

  /**
   * Check if the circuit is open
   * @returns {boolean} - True if circuit is open
   */
  isOpen() {
    return this.breaker?.opened ?? false;
  }

  /**
   * Get the current state
   * @returns {string} - Current state (OPEN, HALF_OPEN, CLOSED)
   */
  getState() {
    if (!this.breaker) return 'CLOSED';
    if (this.breaker.opened) return 'OPEN';
    if (this.breaker.halfOpen) return 'HALF_OPEN';
    return 'CLOSED';
  }
}

// Pre-configured circuit breakers for common operations
export const indexOperationsBreaker = {
  files: null,
  apps: null,
  contacts: null,
  web: null
};

/**
 * Initialize circuit breakers for all index types
 * @param {Function} indexFn - The index function to protect
 */
export function initializeIndexBreakers(indexFn) {
  for (const indexType of Object.keys(indexOperationsBreaker)) {
    indexOperationsBreaker[indexType] = createCircuitBreaker(
      `index_${indexType}`,
      async (params) => indexFn(indexType, params),
      ES_OPTIONS
    );
  }
}

export default {
  createCircuitBreaker,
  createIndexCircuitBreaker,
  withCircuitBreaker,
  getAllCircuitBreakerStates,
  getCircuitBreaker,
  ProtectedIndexOperation,
  indexOperationsBreaker,
  initializeIndexBreakers
};
