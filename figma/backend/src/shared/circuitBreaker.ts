/**
 * Circuit breaker implementation using Opossum.
 * Protects against cascading failures in database and external service calls.
 * Enables graceful degradation when dependencies are unhealthy.
 */
import CircuitBreaker, { Options } from 'opossum';
import { logger } from './logger.js';
import { circuitBreakerCounter, circuitBreakerStateGauge } from './metrics.js';

/**
 * Circuit breaker configuration for local development.
 * More lenient settings suitable for development/testing.
 */
export interface CircuitBreakerConfig {
  /** Number of failures before opening the circuit */
  errorThresholdPercentage: number;
  /** Time in ms before attempting to close an open circuit */
  resetTimeout: number;
  /** Request timeout in ms */
  timeout: number;
  /** Minimum number of requests before calculating error percentage */
  volumeThreshold: number;
}

/**
 * Default configuration for circuit breakers.
 * Optimized for local development with reasonable thresholds.
 */
const defaultConfig: CircuitBreakerConfig = {
  errorThresholdPercentage: 50,  // Open after 50% failures
  resetTimeout: 10000,            // 10s before trying half-open
  timeout: 5000,                  // 5s timeout for operations
  volumeThreshold: 5,             // Need at least 5 requests before calculating percentage
};

/**
 * PostgreSQL-specific circuit breaker configuration.
 * Slightly more tolerant since DB queries can vary in duration.
 */
export const postgresConfig: CircuitBreakerConfig = {
  errorThresholdPercentage: 50,
  resetTimeout: 15000,            // 15s for DB recovery
  timeout: 10000,                 // 10s timeout for DB operations
  volumeThreshold: 3,
};

/**
 * Redis-specific circuit breaker configuration.
 * Faster timeouts since Redis should be very fast.
 */
export const redisConfig: CircuitBreakerConfig = {
  errorThresholdPercentage: 50,
  resetTimeout: 5000,             // 5s for Redis recovery
  timeout: 2000,                  // 2s timeout for Redis operations
  volumeThreshold: 5,
};

/**
 * WebSocket sync-specific circuit breaker configuration.
 * Used to protect real-time sync operations.
 */
export const syncConfig: CircuitBreakerConfig = {
  errorThresholdPercentage: 60,   // More tolerant for sync
  resetTimeout: 5000,
  timeout: 3000,                  // 3s timeout for sync operations
  volumeThreshold: 10,
};

/**
 * Circuit breaker state enum for internal tracking.
 */
enum CircuitState {
  CLOSED = 0,
  OPEN = 1,
  HALF_OPEN = 2,
}

/**
 * Creates a circuit breaker wrapper around an async function.
 * Monitors function calls and opens the circuit on repeated failures.
 * @param name - Unique identifier for the circuit breaker
 * @param fn - The async function to protect
 * @param config - Circuit breaker configuration
 * @returns Wrapped function with circuit breaker protection
 */
export function createCircuitBreaker<TArgs extends unknown[], TResult>(
  name: string,
  fn: (...args: TArgs) => Promise<TResult>,
  config: CircuitBreakerConfig = defaultConfig
): CircuitBreaker<TArgs, TResult> {
  const breaker = new CircuitBreaker(fn, {
    timeout: config.timeout,
    errorThresholdPercentage: config.errorThresholdPercentage,
    resetTimeout: config.resetTimeout,
    volumeThreshold: config.volumeThreshold,
    name,
  } as Options);

  // Set initial state
  circuitBreakerStateGauge.set({ circuit: name }, CircuitState.CLOSED);

  // Event handlers for monitoring
  breaker.on('open', () => {
    logger.warn({ circuit: name }, 'Circuit breaker opened');
    circuitBreakerCounter.inc({ circuit: name, state: 'open' });
    circuitBreakerStateGauge.set({ circuit: name }, CircuitState.OPEN);
  });

  breaker.on('close', () => {
    logger.info({ circuit: name }, 'Circuit breaker closed');
    circuitBreakerCounter.inc({ circuit: name, state: 'closed' });
    circuitBreakerStateGauge.set({ circuit: name }, CircuitState.CLOSED);
  });

  breaker.on('halfOpen', () => {
    logger.info({ circuit: name }, 'Circuit breaker half-open, testing...');
    circuitBreakerCounter.inc({ circuit: name, state: 'half_open' });
    circuitBreakerStateGauge.set({ circuit: name }, CircuitState.HALF_OPEN);
  });

  breaker.on('timeout', () => {
    logger.warn({ circuit: name }, 'Circuit breaker timeout');
  });

  breaker.on('reject', () => {
    logger.warn({ circuit: name }, 'Circuit breaker rejected request (circuit open)');
  });

  breaker.on('fallback', () => {
    logger.debug({ circuit: name }, 'Circuit breaker fallback executed');
  });

  return breaker;
}

/**
 * Registry of all circuit breakers for health reporting.
 */
const circuitRegistry = new Map<string, CircuitBreaker>();

/**
 * Registers a circuit breaker for health check reporting.
 * @param name - Circuit breaker name
 * @param breaker - The circuit breaker instance
 */
export function registerCircuitBreaker(name: string, breaker: CircuitBreaker): void {
  circuitRegistry.set(name, breaker);
}

/**
 * Gets the health status of all registered circuit breakers.
 * @returns Object with circuit breaker health information
 */
export function getCircuitBreakerHealth(): Record<string, { state: string; failures: number; successes: number }> {
  const health: Record<string, { state: string; failures: number; successes: number }> = {};

  circuitRegistry.forEach((breaker, name) => {
    const stats = breaker.stats;
    let state: string;

    if (breaker.opened) {
      state = 'OPEN';
    } else if (breaker.halfOpen) {
      state = 'HALF_OPEN';
    } else {
      state = 'CLOSED';
    }

    health[name] = {
      state,
      failures: stats.failures,
      successes: stats.successes,
    };
  });

  return health;
}

/**
 * Checks if a specific circuit breaker is allowing requests.
 * @param name - Circuit breaker name
 * @returns True if the circuit is closed or half-open
 */
export function isCircuitHealthy(name: string): boolean {
  const breaker = circuitRegistry.get(name);
  if (!breaker) return true;
  return !breaker.opened || breaker.halfOpen;
}

export default createCircuitBreaker;
