/**
 * Circuit breaker implementation using opossum.
 *
 * Protects signaling infrastructure by failing fast when downstream
 * services are unhealthy. This prevents cascade failures and allows
 * the system to recover gracefully.
 *
 * WHY circuit breakers protect signaling infrastructure:
 * - Prevents thread/connection exhaustion when Redis/DB is slow
 * - Enables fast failure instead of hanging requests
 * - Allows automatic recovery when services become healthy
 * - Provides visibility into service health via metrics
 */

import CircuitBreaker from 'opossum';
import { logger } from './logger.js';
import {
  circuitBreakerState,
  circuitBreakerTrips,
} from './metrics.js';

/**
 * Circuit breaker options with sensible defaults for signaling.
 */
export interface CircuitBreakerOptions {
  /** Timeout in milliseconds before considering a request failed */
  timeout?: number;
  /** Error threshold percentage before opening circuit */
  errorThresholdPercentage?: number;
  /** Time in milliseconds to wait before attempting reset */
  resetTimeout?: number;
  /** Minimum number of requests before circuit can trip */
  volumeThreshold?: number;
}

const DEFAULT_OPTIONS: Required<CircuitBreakerOptions> = {
  timeout: 3000,                    // 3 second timeout
  errorThresholdPercentage: 50,     // Open circuit at 50% error rate
  resetTimeout: 10000,              // Try again after 10 seconds
  volumeThreshold: 5,               // Need at least 5 requests
};

/**
 * Map of circuit breaker instances by name.
 */
const breakers = new Map<string, CircuitBreaker>();

/**
 * Creates or retrieves a circuit breaker for a named operation.
 *
 * @param name - Unique name for the circuit breaker
 * @param action - The async function to protect
 * @param options - Optional configuration overrides
 * @returns Configured circuit breaker instance
 */
export function createCircuitBreaker<T>(
  name: string,
  action: (...args: unknown[]) => Promise<T>,
  options: CircuitBreakerOptions = {}
): CircuitBreaker {
  // Return existing breaker if already created
  if (breakers.has(name)) {
    return breakers.get(name)!;
  }

  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };

  const breaker = new CircuitBreaker(action, {
    timeout: mergedOptions.timeout,
    errorThresholdPercentage: mergedOptions.errorThresholdPercentage,
    resetTimeout: mergedOptions.resetTimeout,
    volumeThreshold: mergedOptions.volumeThreshold,
    name,
  });

  // Event handlers for observability
  breaker.on('open', () => {
    logger.warn({ circuit: name }, `Circuit breaker ${name} opened`);
    circuitBreakerState.set({ name }, 1);
    circuitBreakerTrips.inc({ name });
  });

  breaker.on('halfOpen', () => {
    logger.info({ circuit: name }, `Circuit breaker ${name} half-open`);
    circuitBreakerState.set({ name }, 2);
  });

  breaker.on('close', () => {
    logger.info({ circuit: name }, `Circuit breaker ${name} closed`);
    circuitBreakerState.set({ name }, 0);
  });

  breaker.on('timeout', () => {
    logger.warn({ circuit: name }, `Circuit breaker ${name} timeout`);
  });

  breaker.on('reject', () => {
    logger.warn({ circuit: name }, `Circuit breaker ${name} rejected request`);
  });

  breaker.on('fallback', () => {
    logger.debug({ circuit: name }, `Circuit breaker ${name} using fallback`);
  });

  // Set initial state
  circuitBreakerState.set({ name }, 0);

  breakers.set(name, breaker);
  return breaker;
}

/**
 * Gets an existing circuit breaker by name.
 *
 * @param name - Name of the circuit breaker
 * @returns The circuit breaker instance or undefined
 */
export function getCircuitBreaker(name: string): CircuitBreaker | undefined {
  return breakers.get(name);
}

/**
 * Gets the current state of all circuit breakers.
 *
 * @returns Object mapping breaker names to their states
 */
export function getCircuitBreakerStates(): Record<string, { state: string; stats: object }> {
  const states: Record<string, { state: string; stats: object }> = {};

  for (const [name, breaker] of breakers) {
    let state = 'closed';
    if (breaker.opened) {
      state = 'open';
    } else if (breaker.halfOpen) {
      state = 'half-open';
    }

    states[name] = {
      state,
      stats: breaker.stats,
    };
  }

  return states;
}

/**
 * Executes an operation through a circuit breaker.
 * Creates the breaker if it doesn't exist.
 *
 * @param name - Circuit breaker name
 * @param action - The async function to execute
 * @param args - Arguments to pass to the function
 * @param fallback - Optional fallback value if circuit is open
 * @param options - Optional circuit breaker configuration
 * @returns Promise resolving to the action result or fallback
 */
export async function withCircuitBreaker<T>(
  name: string,
  action: (...args: unknown[]) => Promise<T>,
  args: unknown[] = [],
  fallback?: T | (() => T),
  options?: CircuitBreakerOptions
): Promise<T> {
  const breaker = createCircuitBreaker(name, action, options);

  if (fallback !== undefined) {
    if (typeof fallback === 'function') {
      breaker.fallback(fallback as () => T);
    } else {
      breaker.fallback(() => fallback);
    }
  }

  return breaker.fire(...args) as Promise<T>;
}
