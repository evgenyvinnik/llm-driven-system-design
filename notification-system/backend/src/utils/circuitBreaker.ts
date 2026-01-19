import { CircuitBreakerPolicy, ConsecutiveBreaker } from 'cockatiel';
import { createLogger } from './logger.js';
import { circuitBreakerState, circuitBreakerStateChanges } from './metrics.js';
import { Logger } from 'pino';

const log: Logger = createLogger('circuit-breaker');

// Circuit breaker states as numbers for Prometheus
const STATES: Record<string, number> = {
  closed: 0,
  open: 1,
  halfOpen: 2,
};

export interface CircuitBreakerOptions {
  consecutiveFailures?: number;
  halfOpenAfter?: number;
}

interface CircuitBreakerEntry {
  policy: CircuitBreakerPolicy;
  lastState: string;
  options: CircuitBreakerOptions;
}

// Store circuit breakers for each channel provider
const circuitBreakers: Map<string, CircuitBreakerEntry> = new Map();

/**
 * Create a circuit breaker for a delivery channel
 *
 * Configuration rationale:
 * - consecutiveFailures: 5 - Opens after 5 consecutive failures to prevent cascading issues
 * - halfOpenAfter: 30s - Wait 30 seconds before testing if service has recovered
 * - Half-open allows 3 test requests before fully closing
 */
export function createCircuitBreaker(
  channel: string,
  options: CircuitBreakerOptions = {}
): CircuitBreakerPolicy {
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
  policy.onStateChange((state: string) => {
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
    const entry = circuitBreakers.get(channel);
    if (entry) {
      entry.lastState = newState;
    }
  });

  // Listen to circuit break events
  policy.onBreak((result) => {
    log.error({
      channel,
      error: (result.reason as Error)?.message || 'Unknown error',
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
 */
export function getCircuitBreaker(channel: string): CircuitBreakerPolicy {
  if (!circuitBreakers.has(channel)) {
    return createCircuitBreaker(channel);
  }
  return circuitBreakers.get(channel)!.policy;
}

/**
 * Execute an operation with circuit breaker protection
 */
export async function withCircuitBreaker<T>(
  channel: string,
  operation: () => Promise<T>
): Promise<T> {
  const policy = getCircuitBreaker(channel);

  try {
    return await policy.execute(async () => {
      return await operation();
    });
  } catch (error) {
    // Check if it's a circuit breaker rejection
    if ((error as Error).name === 'BrokenCircuitError') {
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
 */
export function getCircuitBreakerState(channel: string): string {
  if (!circuitBreakers.has(channel)) {
    return 'closed';
  }
  return circuitBreakers.get(channel)!.lastState;
}

/**
 * Get all circuit breaker states
 */
export function getAllCircuitBreakerStates(): Record<string, string> {
  const states: Record<string, string> = {};
  for (const [channel, cb] of circuitBreakers) {
    states[channel] = cb.lastState;
  }
  return states;
}

/**
 * Custom error for circuit breaker open state
 */
export class CircuitBreakerOpenError extends Error {
  public channel: string;
  public retryable: boolean;

  constructor(channel: string) {
    super(`Circuit breaker is open for channel: ${channel}`);
    this.name = 'CircuitBreakerOpenError';
    this.channel = channel;
    this.retryable = true; // Can be retried later
  }
}

// Initialize circuit breakers for standard channels
export function initializeCircuitBreakers(): void {
  const channels = ['push', 'email', 'sms'];
  const configs: Record<string, CircuitBreakerOptions> = {
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
