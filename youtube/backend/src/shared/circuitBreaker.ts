import CircuitBreaker from 'opossum';
import logger, { logEvent } from './logger.js';
import { circuitBreakerState, circuitBreakerFailuresTotal } from './metrics.js';

/**
 * Circuit Breaker Module
 *
 * Circuit breakers prevent cascade failures by:
 * 1. Detecting when a service is failing repeatedly
 * 2. "Opening" the circuit to fail fast instead of waiting
 * 3. Periodically testing if the service has recovered
 * 4. "Closing" the circuit when the service is healthy again
 *
 * States:
 * - CLOSED (0): Normal operation, requests pass through
 * - OPEN (1): Service is down, requests fail immediately
 * - HALF_OPEN (2): Testing if service has recovered
 */

// Circuit breaker state constants
const STATE = {
  CLOSED: 0,
  OPEN: 1,
  HALF_OPEN: 2,
};

// Default circuit breaker options
const DEFAULT_OPTIONS = {
  timeout: 10000,           // 10s - time to wait for response
  errorThresholdPercentage: 50, // Open circuit if 50% of requests fail
  resetTimeout: 30000,      // 30s - time before trying again
  volumeThreshold: 5,       // Minimum requests before tripping
};

// Store all circuit breakers for health checks
const circuitBreakers = new Map();

/**
 * Create a circuit breaker for a service
 *
 * @param {string} name - Service name (e.g., 'storage', 'transcoding')
 * @param {Function} fn - Async function to wrap
 * @param {object} options - Circuit breaker options
 * @returns {CircuitBreaker} Configured circuit breaker
 */
export function createCircuitBreaker(name, fn, options = {}) {
  const breaker = new CircuitBreaker(fn, {
    ...DEFAULT_OPTIONS,
    ...options,
    name,
  });

  // Event handlers for monitoring
  breaker.on('success', (result, latencyMs) => {
    logger.debug({
      event: 'circuit_breaker_success',
      service: name,
      latencyMs,
    }, `Circuit breaker ${name}: success`);
  });

  breaker.on('timeout', () => {
    logger.warn({
      event: 'circuit_breaker_timeout',
      service: name,
    }, `Circuit breaker ${name}: timeout`);
    circuitBreakerFailuresTotal.inc({ service: name });
  });

  breaker.on('reject', () => {
    logger.warn({
      event: 'circuit_breaker_reject',
      service: name,
    }, `Circuit breaker ${name}: rejected (circuit open)`);
  });

  breaker.on('open', () => {
    logEvent.circuitBreakerOpen(logger, {
      service: name,
      failures: breaker.stats.failures,
    });
    circuitBreakerState.set({ service: name }, STATE.OPEN);
  });

  breaker.on('halfOpen', () => {
    logger.info({
      event: 'circuit_breaker_half_open',
      service: name,
    }, `Circuit breaker ${name}: half-open (testing)`);
    circuitBreakerState.set({ service: name }, STATE.HALF_OPEN);
  });

  breaker.on('close', () => {
    logEvent.circuitBreakerClose(logger, { service: name });
    circuitBreakerState.set({ service: name }, STATE.CLOSED);
  });

  breaker.on('failure', (error) => {
    logger.warn({
      event: 'circuit_breaker_failure',
      service: name,
      error: error.message,
    }, `Circuit breaker ${name}: failure`);
    circuitBreakerFailuresTotal.inc({ service: name });
  });

  breaker.on('fallback', (result) => {
    logger.info({
      event: 'circuit_breaker_fallback',
      service: name,
    }, `Circuit breaker ${name}: using fallback`);
  });

  // Initialize metrics
  circuitBreakerState.set({ service: name }, STATE.CLOSED);

  // Store for health checks
  circuitBreakers.set(name, breaker);

  return breaker;
}

/**
 * Create circuit-protected wrapper function
 *
 * @param {string} name - Service name
 * @param {Function} fn - Function to wrap
 * @param {Function} fallback - Optional fallback function
 * @param {object} options - Circuit breaker options
 * @returns {Function} Wrapped function
 */
export function withCircuitBreaker(name, fn, fallback = null, options = {}) {
  const breaker = createCircuitBreaker(name, fn, options);

  if (fallback) {
    breaker.fallback(fallback);
  }

  return async (...args) => {
    try {
      return await breaker.fire(...args);
    } catch (error) {
      // Re-throw if no fallback and circuit is open
      if (breaker.opened) {
        const circuitError = new Error(`Service ${name} is unavailable (circuit open)`);
        circuitError.code = 'CIRCUIT_OPEN';
        circuitError.service = name;
        throw circuitError;
      }
      throw error;
    }
  };
}

/**
 * Get health status of all circuit breakers
 * @returns {object} Health status
 */
export function getCircuitBreakerHealth() {
  const health = {};

  for (const [name, breaker] of circuitBreakers) {
    health[name] = {
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

  return health;
}

/**
 * Check if any circuit breaker is open
 * @returns {boolean} True if any circuit is open
 */
export function hasOpenCircuit() {
  for (const [, breaker] of circuitBreakers) {
    if (breaker.opened) {
      return true;
    }
  }
  return false;
}

/**
 * Get a specific circuit breaker
 * @param {string} name - Circuit breaker name
 * @returns {CircuitBreaker|undefined}
 */
export function getCircuitBreaker(name) {
  return circuitBreakers.get(name);
}

export default {
  createCircuitBreaker,
  withCircuitBreaker,
  getCircuitBreakerHealth,
  hasOpenCircuit,
  getCircuitBreaker,
};
