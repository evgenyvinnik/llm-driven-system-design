/**
 * Circuit breaker module for the job scheduler.
 * Provides fault tolerance for job execution by preventing cascading failures.
 * Uses the opossum library for circuit breaker pattern implementation.
 * @module shared/circuit-breaker
 */

import CircuitBreaker from 'opossum';
import { logger } from '../utils/logger';
import { circuitBreakerState, circuitBreakerTrips } from './metrics';

/**
 * Circuit breaker options for job execution.
 */
export interface CircuitBreakerOptions {
  /** Time in milliseconds to wait before a request is considered failed */
  timeout?: number;
  /** Error percentage threshold to trip the circuit */
  errorThresholdPercentage?: number;
  /** Time in milliseconds to wait before testing the circuit again */
  resetTimeout?: number;
  /** Number of requests allowed in half-open state */
  volumeThreshold?: number;
}

/**
 * Default circuit breaker configuration.
 */
const defaultOptions: CircuitBreakerOptions = {
  timeout: 60000, // 60 seconds
  errorThresholdPercentage: 50, // Trip at 50% failures
  resetTimeout: 30000, // Try again after 30 seconds
  volumeThreshold: 5, // Need at least 5 requests to trip
};

/**
 * Registry of circuit breakers by handler name.
 */
const circuitBreakers: Map<string, CircuitBreaker<unknown[], unknown>> = new Map();

/**
 * Creates a circuit breaker for a specific handler.
 * Each handler gets its own circuit breaker to isolate failures.
 * @param handlerName - Name of the handler
 * @param fn - Function to wrap with circuit breaker
 * @param options - Circuit breaker options
 * @returns Circuit breaker instance
 */
export function createCircuitBreaker<T, R>(
  handlerName: string,
  fn: (...args: T[]) => Promise<R>,
  options: CircuitBreakerOptions = {}
): CircuitBreaker<T[], R> {
  const mergedOptions = { ...defaultOptions, ...options };

  const breaker = new CircuitBreaker(fn, {
    timeout: mergedOptions.timeout,
    errorThresholdPercentage: mergedOptions.errorThresholdPercentage,
    resetTimeout: mergedOptions.resetTimeout,
    volumeThreshold: mergedOptions.volumeThreshold,
    name: handlerName,
  });

  // Set up event handlers for logging and metrics
  breaker.on('success', (result) => {
    logger.debug({ handler: handlerName }, 'Circuit breaker: success');
    circuitBreakerState.set({ handler: handlerName }, 0); // closed
  });

  breaker.on('timeout', () => {
    logger.warn({ handler: handlerName }, 'Circuit breaker: timeout');
  });

  breaker.on('reject', () => {
    logger.warn({ handler: handlerName }, 'Circuit breaker: rejected (circuit open)');
  });

  breaker.on('open', () => {
    logger.warn({ handler: handlerName }, 'Circuit breaker: opened');
    circuitBreakerState.set({ handler: handlerName }, 1); // open
    circuitBreakerTrips.inc({ handler: handlerName });
  });

  breaker.on('halfOpen', () => {
    logger.info({ handler: handlerName }, 'Circuit breaker: half-open');
    circuitBreakerState.set({ handler: handlerName }, 0.5); // half-open
  });

  breaker.on('close', () => {
    logger.info({ handler: handlerName }, 'Circuit breaker: closed');
    circuitBreakerState.set({ handler: handlerName }, 0); // closed
  });

  breaker.on('fallback', (result) => {
    logger.info({ handler: handlerName, result }, 'Circuit breaker: fallback executed');
  });

  circuitBreakers.set(handlerName, breaker as CircuitBreaker<unknown[], unknown>);
  circuitBreakerState.set({ handler: handlerName }, 0); // Initialize as closed

  return breaker;
}

/**
 * Gets or creates a circuit breaker for a handler.
 * @param handlerName - Name of the handler
 * @param fn - Function to wrap (used if creating new breaker)
 * @param options - Circuit breaker options
 * @returns Circuit breaker instance
 */
export function getCircuitBreaker<T, R>(
  handlerName: string,
  fn?: (...args: T[]) => Promise<R>,
  options?: CircuitBreakerOptions
): CircuitBreaker<T[], R> | undefined {
  let breaker = circuitBreakers.get(handlerName);

  if (!breaker && fn) {
    breaker = createCircuitBreaker(handlerName, fn, options) as CircuitBreaker<unknown[], unknown>;
  }

  return breaker as CircuitBreaker<T[], R> | undefined;
}

/**
 * Gets the current state of all circuit breakers.
 * Useful for monitoring and debugging.
 * @returns Map of handler names to their circuit breaker states
 */
export function getCircuitBreakerStates(): Map<string, CircuitBreakerState> {
  const states = new Map<string, CircuitBreakerState>();

  for (const [name, breaker] of circuitBreakers) {
    states.set(name, {
      name,
      state: breaker.opened ? 'open' : breaker.halfOpen ? 'half-open' : 'closed',
      stats: {
        successes: breaker.stats.successes,
        failures: breaker.stats.failures,
        timeouts: breaker.stats.timeouts,
        rejects: breaker.stats.rejects,
        fallbacks: breaker.stats.fallbacks,
      },
    });
  }

  return states;
}

/**
 * Circuit breaker state information.
 */
export interface CircuitBreakerState {
  name: string;
  state: 'closed' | 'open' | 'half-open';
  stats: {
    successes: number;
    failures: number;
    timeouts: number;
    rejects: number;
    fallbacks: number;
  };
}

/**
 * Resets all circuit breakers.
 * Useful for testing or manual intervention.
 */
export function resetAllCircuitBreakers(): void {
  for (const [name, breaker] of circuitBreakers) {
    breaker.close();
    logger.info({ handler: name }, 'Circuit breaker reset');
  }
}

/**
 * Wraps a job handler function with a circuit breaker.
 * Provides automatic failure isolation for job execution.
 * @param handlerName - Name of the handler
 * @param handler - Handler function to wrap
 * @param options - Circuit breaker options
 * @returns Wrapped handler function
 */
export function withCircuitBreaker<T extends unknown[], R>(
  handlerName: string,
  handler: (...args: T) => Promise<R>,
  options?: CircuitBreakerOptions
): (...args: T) => Promise<R> {
  const breaker = createCircuitBreaker(handlerName, handler, options);

  return async (...args: T): Promise<R> => {
    try {
      return await breaker.fire(...args) as R;
    } catch (error) {
      // Check if the error is from the circuit breaker itself
      if (error instanceof Error && error.message.includes('Breaker is open')) {
        throw new CircuitBreakerOpenError(
          handlerName,
          `Circuit breaker for ${handlerName} is open - service unavailable`
        );
      }
      throw error;
    }
  };
}

/**
 * Error thrown when a circuit breaker is open.
 */
export class CircuitBreakerOpenError extends Error {
  public readonly handlerName: string;

  constructor(handlerName: string, message: string) {
    super(message);
    this.name = 'CircuitBreakerOpenError';
    this.handlerName = handlerName;
  }
}

logger.info('Circuit breaker module initialized');
