/**
 * Circuit breaker pattern for external service calls.
 * Protects against cascading failures when sources are slow or unavailable.
 * Uses opossum library for circuit breaker implementation.
 * @module shared/circuit-breaker
 */

import CircuitBreaker from 'opossum';
import { logger } from './logger.js';
import { circuitBreakerState, crawlerFetchTotal } from './metrics.js';

/**
 * Configuration options for circuit breakers.
 */
export interface CircuitBreakerOptions {
  /** Time in ms to wait before timing out the request (default: 10000) */
  timeout?: number;
  /** Percentage of failures before opening circuit (default: 50) */
  errorThresholdPercentage?: number;
  /** Time in ms to wait before trying again after circuit opens (default: 30000) */
  resetTimeout?: number;
  /** Minimum number of requests before circuit can trip (default: 5) */
  volumeThreshold?: number;
  /** Name for logging and metrics */
  name?: string;
}

const DEFAULT_OPTIONS: Required<Omit<CircuitBreakerOptions, 'name'>> = {
  timeout: 10000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
  volumeThreshold: 5,
};

/**
 * Map of circuit breakers by name for centralized management.
 */
const circuitBreakers = new Map<string, CircuitBreaker>();

/**
 * Create a circuit breaker for an async function.
 * Circuit breakers prevent repeated calls to failing services.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Too many failures, requests fail immediately
 * - HALF_OPEN: Testing if service recovered
 *
 * @param fn - The async function to wrap
 * @param options - Circuit breaker configuration
 * @returns Wrapped function with circuit breaker protection
 */
export function createCircuitBreaker<T extends unknown[], R>(
  fn: (...args: T) => Promise<R>,
  options: CircuitBreakerOptions = {}
): CircuitBreaker<T, R> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const name = options.name || fn.name || 'unnamed';

  const breaker = new CircuitBreaker(fn, {
    timeout: opts.timeout,
    errorThresholdPercentage: opts.errorThresholdPercentage,
    resetTimeout: opts.resetTimeout,
    volumeThreshold: opts.volumeThreshold,
    name,
  });

  // Set up event handlers for logging and metrics
  breaker.on('success', () => {
    logger.debug({ circuitBreaker: name }, 'Circuit breaker call succeeded');
  });

  breaker.on('timeout', () => {
    logger.warn({ circuitBreaker: name }, 'Circuit breaker call timed out');
    crawlerFetchTotal.inc({ status: 'timeout' });
  });

  breaker.on('reject', () => {
    logger.warn({ circuitBreaker: name }, 'Circuit breaker rejected call (circuit open)');
    crawlerFetchTotal.inc({ status: 'circuit_open' });
  });

  breaker.on('open', () => {
    logger.warn({ circuitBreaker: name }, 'Circuit breaker opened - too many failures');
    circuitBreakerState.set({ name }, 1);
  });

  breaker.on('halfOpen', () => {
    logger.info({ circuitBreaker: name }, 'Circuit breaker half-open - testing service');
    circuitBreakerState.set({ name }, 2);
  });

  breaker.on('close', () => {
    logger.info({ circuitBreaker: name }, 'Circuit breaker closed - service recovered');
    circuitBreakerState.set({ name }, 0);
  });

  breaker.on('fallback', () => {
    logger.debug({ circuitBreaker: name }, 'Circuit breaker using fallback');
  });

  // Store for centralized management
  circuitBreakers.set(name, breaker);

  // Initialize metric
  circuitBreakerState.set({ name }, 0);

  return breaker;
}

/**
 * Get a circuit breaker by name.
 * @param name - The name of the circuit breaker
 * @returns The circuit breaker or undefined if not found
 */
export function getCircuitBreaker(name: string): CircuitBreaker | undefined {
  return circuitBreakers.get(name);
}

/**
 * Get all circuit breaker statistics.
 * Useful for health checks and debugging.
 * @returns Map of circuit breaker names to their stats
 */
export function getAllCircuitBreakerStats(): Map<string, CircuitBreaker.Stats> {
  const stats = new Map<string, CircuitBreaker.Stats>();
  for (const [name, breaker] of circuitBreakers) {
    stats.set(name, breaker.stats);
  }
  return stats;
}

/**
 * Reset all circuit breakers.
 * Useful for testing or manual recovery.
 */
export function resetAllCircuitBreakers(): void {
  for (const [name, breaker] of circuitBreakers) {
    breaker.close();
    logger.info({ circuitBreaker: name }, 'Circuit breaker manually reset');
  }
}

/**
 * Create a circuit breaker specifically for RSS feed fetching.
 * Pre-configured with appropriate settings for external HTTP calls.
 * @param sourceName - Name of the source for logging
 * @returns Circuit breaker for fetch operations
 */
export function createFetchCircuitBreaker(
  sourceName: string
): CircuitBreaker<[string, RequestInit?], Response> {
  const fetchFn = async (url: string, options?: RequestInit): Promise<Response> => {
    return fetch(url, options);
  };

  return createCircuitBreaker(fetchFn, {
    name: `fetch:${sourceName}`,
    timeout: 15000, // 15 seconds for RSS feeds
    errorThresholdPercentage: 50,
    resetTimeout: 60000, // 1 minute before retry
    volumeThreshold: 3, // Trip after 3 failures
  });
}

/**
 * Global circuit breaker for all RSS fetches.
 * Used when a source doesn't have its own breaker.
 */
export const globalFetchBreaker = createCircuitBreaker(
  async (url: string, options?: RequestInit): Promise<Response> => {
    return fetch(url, options);
  },
  {
    name: 'global-fetch',
    timeout: 15000,
    errorThresholdPercentage: 60,
    resetTimeout: 30000,
    volumeThreshold: 10,
  }
);
