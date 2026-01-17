/**
 * @fileoverview Circuit breaker implementation using opossum.
 * Provides fault tolerance for external service calls (payment, search, etc.)
 * with automatic failure detection and recovery.
 */

import CircuitBreaker from 'opossum';
import { logger, logging } from './logger.js';
import { circuitBreakerState, circuitBreakerFailures, circuitBreakerSuccesses } from './metrics.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Circuit breaker configuration options.
 */
export interface CircuitBreakerOptions {
  /** Name for identification and metrics */
  name: string;
  /** Time in ms after which a request is considered failed (default: 10000) */
  timeout?: number;
  /** Number of failures before opening the circuit (default: 5) */
  errorThresholdPercentage?: number;
  /** Time in ms before attempting to close the circuit (default: 30000) */
  resetTimeout?: number;
  /** Minimum number of requests before failure threshold kicks in (default: 5) */
  volumeThreshold?: number;
  /** Whether to enable caching of results (default: false) */
  cache?: boolean;
}

/**
 * Map of circuit breaker state strings to numeric values for metrics.
 */
const STATE_VALUES = {
  closed: 0,
  halfOpen: 1,
  open: 2,
} as const;

// =============================================================================
// Circuit Breaker Registry
// =============================================================================

const circuitBreakers = new Map<string, CircuitBreaker>();

/**
 * Creates or retrieves a circuit breaker for a given operation.
 *
 * @param fn - The async function to wrap
 * @param options - Circuit breaker configuration
 * @returns Wrapped circuit breaker instance
 *
 * @example
 * const paymentBreaker = createCircuitBreaker(
 *   async (userId, amount) => paymentProvider.charge(userId, amount),
 *   { name: 'payment', timeout: 5000, errorThresholdPercentage: 50 }
 * );
 *
 * // Use it
 * try {
 *   const result = await paymentBreaker.fire(userId, amount);
 * } catch (error) {
 *   if (error.message === 'Breaker is open') {
 *     // Circuit is open, fail fast
 *   }
 * }
 */
export function createCircuitBreaker<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  options: CircuitBreakerOptions
): CircuitBreaker<Parameters<T>, ReturnType<T>> {
  const {
    name,
    timeout = 10000,
    errorThresholdPercentage = 50,
    resetTimeout = 30000,
    volumeThreshold = 5,
    cache = false,
  } = options;

  // Return existing breaker if already created
  if (circuitBreakers.has(name)) {
    return circuitBreakers.get(name)! as CircuitBreaker<Parameters<T>, ReturnType<T>>;
  }

  const breaker = new CircuitBreaker(fn, {
    timeout,
    errorThresholdPercentage,
    resetTimeout,
    volumeThreshold,
    cache,
    name,
  });

  // Set up event handlers for logging and metrics
  breaker.on('success', (result, latency) => {
    circuitBreakerSuccesses.inc({ name });
    logger.debug({ breaker: name, latency }, 'Circuit breaker call succeeded');
  });

  breaker.on('failure', (error, latency) => {
    circuitBreakerFailures.inc({ name });
    logger.warn({ breaker: name, error: error.message, latency }, 'Circuit breaker call failed');
  });

  breaker.on('timeout', (latency) => {
    circuitBreakerFailures.inc({ name });
    logger.warn({ breaker: name, latency }, 'Circuit breaker call timed out');
  });

  breaker.on('reject', () => {
    circuitBreakerFailures.inc({ name });
    logger.warn({ breaker: name }, 'Circuit breaker rejected call (circuit open)');
  });

  breaker.on('open', () => {
    circuitBreakerState.set({ name }, STATE_VALUES.open);
    logging.circuitBreaker(name, 'open', breaker.stats.failures);
  });

  breaker.on('halfOpen', () => {
    circuitBreakerState.set({ name }, STATE_VALUES.halfOpen);
    logging.circuitBreaker(name, 'half-open');
  });

  breaker.on('close', () => {
    circuitBreakerState.set({ name }, STATE_VALUES.closed);
    logging.circuitBreaker(name, 'closed');
  });

  // Initialize metrics
  circuitBreakerState.set({ name }, STATE_VALUES.closed);

  // Store in registry
  circuitBreakers.set(name, breaker);

  return breaker as CircuitBreaker<Parameters<T>, ReturnType<T>>;
}

/**
 * Gets the current state of a circuit breaker.
 */
export function getCircuitBreakerState(name: string): 'closed' | 'open' | 'halfOpen' | null {
  const breaker = circuitBreakers.get(name);
  if (!breaker) return null;

  if (breaker.opened) return 'open';
  if (breaker.halfOpen) return 'halfOpen';
  return 'closed';
}

/**
 * Gets statistics for a circuit breaker.
 */
export function getCircuitBreakerStats(name: string): object | null {
  const breaker = circuitBreakers.get(name);
  if (!breaker) return null;

  return {
    name,
    state: getCircuitBreakerState(name),
    stats: breaker.stats,
  };
}

/**
 * Gets all registered circuit breakers and their states.
 */
export function getAllCircuitBreakerStats(): object[] {
  const stats: object[] = [];
  for (const [name] of circuitBreakers) {
    const s = getCircuitBreakerStats(name);
    if (s) stats.push(s);
  }
  return stats;
}

/**
 * Resets a circuit breaker to closed state.
 * Use cautiously - only for testing or manual intervention.
 */
export function resetCircuitBreaker(name: string): boolean {
  const breaker = circuitBreakers.get(name);
  if (!breaker) return false;

  breaker.close();
  logger.info({ breaker: name }, 'Circuit breaker manually reset');
  return true;
}

// =============================================================================
// Pre-configured Circuit Breakers
// =============================================================================

/**
 * Circuit breaker for payment provider calls.
 * Aggressive timeouts and low threshold since payment failures are critical.
 */
export function createPaymentCircuitBreaker<T extends (...args: any[]) => Promise<any>>(
  fn: T
): CircuitBreaker<Parameters<T>, ReturnType<T>> {
  return createCircuitBreaker(fn, {
    name: 'payment',
    timeout: 5000,           // 5 second timeout for payment calls
    errorThresholdPercentage: 30, // Open at 30% failure rate
    resetTimeout: 60000,     // Wait 1 minute before retrying
    volumeThreshold: 3,      // Start checking after 3 requests
  });
}

/**
 * Circuit breaker for Elasticsearch calls.
 * More lenient since search degradation is less critical than payment.
 */
export function createSearchCircuitBreaker<T extends (...args: any[]) => Promise<any>>(
  fn: T
): CircuitBreaker<Parameters<T>, ReturnType<T>> {
  return createCircuitBreaker(fn, {
    name: 'elasticsearch',
    timeout: 10000,          // 10 second timeout
    errorThresholdPercentage: 50,
    resetTimeout: 30000,     // 30 seconds
    volumeThreshold: 5,
  });
}

/**
 * Circuit breaker for external API calls (generic).
 */
export function createExternalApiCircuitBreaker<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  name: string
): CircuitBreaker<Parameters<T>, ReturnType<T>> {
  return createCircuitBreaker(fn, {
    name,
    timeout: 15000,
    errorThresholdPercentage: 50,
    resetTimeout: 30000,
    volumeThreshold: 5,
  });
}

/**
 * Fallback wrapper that executes a fallback function when the circuit is open.
 *
 * @example
 * const searchWithFallback = withFallback(
 *   searchCircuitBreaker,
 *   async (query) => {
 *     // Fallback to PostgreSQL full-text search
 *     return postgresSearch(query);
 *   }
 * );
 */
export function withFallback<T extends (...args: any[]) => Promise<any>>(
  breaker: CircuitBreaker<Parameters<T>, ReturnType<T>>,
  fallbackFn: T
): (...args: Parameters<T>) => ReturnType<T> {
  breaker.fallback(fallbackFn);
  return (...args: Parameters<T>) => breaker.fire(...args) as ReturnType<T>;
}
