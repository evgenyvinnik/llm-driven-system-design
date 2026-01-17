import { CircuitBreakerPolicy, ConsecutiveBreaker, handleAll } from 'cockatiel';
import { createLogger } from './logger.js';
import { circuitBreakerState, circuitBreakerStateChanges } from './metrics.js';

const log = createLogger('circuit-breaker');

// Circuit breaker states as numbers for Prometheus
const STATES = {
  closed: 0,
  open: 1,
  halfOpen: 2,
};

// Store circuit breakers for each channel provider
const circuitBreakers = new Map();

/**
 * Create a circuit breaker for a delivery channel
 *
 * Configuration rationale:
 * - consecutiveFailures: 5 - Opens after 5 consecutive failures to prevent cascading issues
 * - halfOpenAfter: 30s - Wait 30 seconds before testing if service has recovered
 * - Half-open allows 3 test requests before fully closing
 *
 * @param {string} channel - Channel name (push, email, sms)
 * @param {Object} options - Configuration options
 * @returns {CircuitBreakerPolicy}
 */
export function createCircuitBreaker(channel, options = {}) {
  const {
    consecutiveFailures = 5,
    halfOpenAfter = 30000, // 30 seconds
  } = options;

  // Use consecutive breaker strategy - opens after N consecutive failures
  const breaker = new ConsecutiveBreaker(consecutiveFailures);

  const policy = CircuitBreakerPolicy.create({
    halfOpenAfter,
    breaker,
  });

  // Set initial state
  circuitBreakerState.labels(channel).set(STATES.closed);

  // Listen to state changes for logging and metrics
  policy.onStateChange((state) => {
    const previousState = circuitBreakers.get(channel)?.lastState || 'closed';
    const newState = state;

    log.warn({
      channel,
      previousState,
      newState,
      timestamp: new Date().toISOString(),
    }, `Circuit breaker state changed: ${previousState} -> ${newState}`);

    // Update Prometheus metrics
    circuitBreakerState.labels(channel).set(STATES[newState] ?? 0);
    circuitBreakerStateChanges.labels(channel, previousState, newState).inc();

    // Store last known state
    if (circuitBreakers.has(channel)) {
      circuitBreakers.get(channel).lastState = newState;
    }
  });

  // Listen to circuit break events
  policy.onBreak((result) => {
    log.error({
      channel,
      error: result.reason?.message || 'Unknown error',
    }, `Circuit breaker opened for channel: ${channel}`);
  });

  // Listen to circuit reset events
  policy.onReset(() => {
    log.info({
      channel,
    }, `Circuit breaker closed for channel: ${channel}`);
  });

  // Listen to half-open events
  policy.onHalfOpen(() => {
    log.info({
      channel,
    }, `Circuit breaker half-open for channel: ${channel}`);
  });

  // Store the circuit breaker
  circuitBreakers.set(channel, {
    policy,
    lastState: 'closed',
    options,
  });

  return policy;
}

/**
 * Get or create a circuit breaker for a channel
 *
 * @param {string} channel - Channel name
 * @returns {CircuitBreakerPolicy}
 */
export function getCircuitBreaker(channel) {
  if (!circuitBreakers.has(channel)) {
    return createCircuitBreaker(channel);
  }
  return circuitBreakers.get(channel).policy;
}

/**
 * Execute an operation with circuit breaker protection
 *
 * @param {string} channel - Channel name
 * @param {Function} operation - Async operation to execute
 * @returns {Promise<any>}
 */
export async function withCircuitBreaker(channel, operation) {
  const policy = getCircuitBreaker(channel);

  try {
    return await policy.execute(async () => {
      return await operation();
    });
  } catch (error) {
    // Check if it's a circuit breaker rejection
    if (error.name === 'BrokenCircuitError') {
      log.warn({
        channel,
      }, `Request rejected by circuit breaker for channel: ${channel}`);

      throw new CircuitBreakerOpenError(channel);
    }
    throw error;
  }
}

/**
 * Get the current state of a circuit breaker
 *
 * @param {string} channel - Channel name
 * @returns {string} - State: 'closed', 'open', or 'halfOpen'
 */
export function getCircuitBreakerState(channel) {
  if (!circuitBreakers.has(channel)) {
    return 'closed';
  }
  return circuitBreakers.get(channel).lastState;
}

/**
 * Get all circuit breaker states
 *
 * @returns {Object} - Map of channel to state
 */
export function getAllCircuitBreakerStates() {
  const states = {};
  for (const [channel, cb] of circuitBreakers) {
    states[channel] = cb.lastState;
  }
  return states;
}

/**
 * Custom error for circuit breaker open state
 */
export class CircuitBreakerOpenError extends Error {
  constructor(channel) {
    super(`Circuit breaker is open for channel: ${channel}`);
    this.name = 'CircuitBreakerOpenError';
    this.channel = channel;
    this.retryable = true; // Can be retried later
  }
}

// Initialize circuit breakers for standard channels
export function initializeCircuitBreakers() {
  const channels = ['push', 'email', 'sms'];
  const configs = {
    push: { consecutiveFailures: 5, halfOpenAfter: 30000 },
    email: { consecutiveFailures: 3, halfOpenAfter: 60000 }, // Email provider more sensitive
    sms: { consecutiveFailures: 3, halfOpenAfter: 60000 },   // SMS provider more sensitive
  };

  for (const channel of channels) {
    createCircuitBreaker(channel, configs[channel]);
    log.info({ channel, config: configs[channel] }, `Initialized circuit breaker for ${channel}`);
  }
}

export default {
  createCircuitBreaker,
  getCircuitBreaker,
  withCircuitBreaker,
  getCircuitBreakerState,
  getAllCircuitBreakerStates,
  initializeCircuitBreakers,
  CircuitBreakerOpenError,
};
