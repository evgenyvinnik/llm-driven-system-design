import CircuitBreaker from 'opossum';
import { logger, logCircuitBreaker } from './logger.js';
import {
  circuitBreakerFailures,
  circuitBreakerSuccesses,
  updateCircuitBreakerState,
} from './metrics.js';

/**
 * Circuit Breaker Module
 *
 * Implements the circuit breaker pattern for external service calls:
 * - Elasticsearch search and geo operations
 * - PostgreSQL geo queries (heavy operations)
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Service is failing, requests are rejected immediately
 * - HALF_OPEN: Testing if service recovered, limited requests allowed
 */

// Circuit breaker options interface
interface CircuitBreakerOptions {
  timeout?: number;
  errorThresholdPercentage?: number;
  resetTimeout?: number;
  volumeThreshold?: number;
  name?: string;
}

// Circuit breaker status interface
interface CircuitBreakerStatusEntry {
  state: 'OPEN' | 'CLOSED' | 'HALF_OPEN';
  stats: unknown;
}

// Default circuit breaker options
const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  timeout: 5000, // 5 second timeout
  errorThresholdPercentage: 50, // Open circuit if 50% of requests fail
  resetTimeout: 30000, // Try again after 30 seconds
  volumeThreshold: 5, // Minimum requests before circuit can open
};

// Store all circuit breakers for health checks
const circuitBreakers: Map<string, CircuitBreaker> = new Map();

/**
 * Create a circuit breaker for a given function
 */
export function createCircuitBreaker<T extends (...args: unknown[]) => unknown>(
  name: string,
  fn: T,
  options: CircuitBreakerOptions = {}
): CircuitBreaker<T> {
  const breaker = new CircuitBreaker(fn, {
    ...DEFAULT_OPTIONS,
    ...options,
    name,
  });

  // Log state changes
  breaker.on('open', () => {
    logCircuitBreaker(name, 'OPEN', { reason: 'failure threshold exceeded' });
    updateCircuitBreakerState(name, 'OPEN');
  });

  breaker.on('halfOpen', () => {
    logCircuitBreaker(name, 'HALF_OPEN', { reason: 'reset timeout elapsed' });
    updateCircuitBreakerState(name, 'HALF_OPEN');
  });

  breaker.on('close', () => {
    logCircuitBreaker(name, 'CLOSED', { reason: 'service recovered' });
    updateCircuitBreakerState(name, 'CLOSED');
  });

  // Track failures and successes
  breaker.on('failure', (error: Error) => {
    circuitBreakerFailures.inc({ name });
    logger.warn(
      { component: 'circuit_breaker', name, error: error.message },
      'Circuit breaker failure'
    );
  });

  breaker.on('success', () => {
    circuitBreakerSuccesses.inc({ name });
  });

  // Log when requests are rejected due to open circuit
  breaker.on('reject', () => {
    logger.warn(
      { component: 'circuit_breaker', name },
      'Request rejected - circuit is open'
    );
  });

  // Log timeouts
  breaker.on('timeout', () => {
    logger.warn(
      { component: 'circuit_breaker', name },
      'Request timed out'
    );
  });

  // Initialize state metric
  updateCircuitBreakerState(name, 'CLOSED');

  // Store for health checks
  circuitBreakers.set(name, breaker);

  return breaker as CircuitBreaker<T>;
}

/**
 * Get all circuit breaker statuses for health check
 */
export function getCircuitBreakerStatus(): Record<string, CircuitBreakerStatusEntry> {
  const status: Record<string, CircuitBreakerStatusEntry> = {};
  for (const [name, breaker] of circuitBreakers) {
    status[name] = {
      state: breaker.opened
        ? 'OPEN'
        : breaker.halfOpen
          ? 'HALF_OPEN'
          : 'CLOSED',
      stats: breaker.stats,
    };
  }
  return status;
}

/**
 * Create Elasticsearch search circuit breaker
 */
let esSearchBreaker: CircuitBreaker | null = null;

export function getElasticsearchSearchBreaker<T extends (...args: unknown[]) => unknown>(
  searchFn: T
): CircuitBreaker<T> {
  if (!esSearchBreaker) {
    esSearchBreaker = createCircuitBreaker('elasticsearch_search', searchFn, {
      timeout: 3000, // 3 second timeout for search
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    });
  }
  return esSearchBreaker as CircuitBreaker<T>;
}

/**
 * Create Elasticsearch autocomplete circuit breaker
 */
let esAutocompleteBreaker: CircuitBreaker | null = null;

export function getElasticsearchAutocompleteBreaker<T extends (...args: unknown[]) => unknown>(
  autocompleteFn: T
): CircuitBreaker<T> {
  if (!esAutocompleteBreaker) {
    esAutocompleteBreaker = createCircuitBreaker(
      'elasticsearch_autocomplete',
      autocompleteFn,
      {
        timeout: 2000, // 2 second timeout for autocomplete
        errorThresholdPercentage: 60,
        resetTimeout: 20000,
      }
    );
  }
  return esAutocompleteBreaker as CircuitBreaker<T>;
}

/**
 * Create PostgreSQL geo query circuit breaker
 */
let pgGeoBreaker: CircuitBreaker | null = null;

export function getPostgresGeoBreaker<T extends (...args: unknown[]) => unknown>(
  geoQueryFn: T
): CircuitBreaker<T> {
  if (!pgGeoBreaker) {
    pgGeoBreaker = createCircuitBreaker('postgres_geo', geoQueryFn, {
      timeout: 5000, // 5 second timeout for geo queries
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    });
  }
  return pgGeoBreaker as CircuitBreaker<T>;
}

/**
 * Wrap a function with circuit breaker protection
 */
export function withCircuitBreaker<T extends (...args: unknown[]) => Promise<unknown>>(
  name: string,
  fn: T,
  options: CircuitBreakerOptions = {}
): (...args: Parameters<T>) => Promise<ReturnType<T>> {
  const breaker = createCircuitBreaker(name, fn, options);

  return async (...args: Parameters<T>): Promise<ReturnType<T>> => {
    try {
      return (await breaker.fire(...args)) as ReturnType<T>;
    } catch (error) {
      if ((error as Error).message === 'Breaker is open') {
        // Circuit is open, provide fallback behavior
        throw new Error(`Service unavailable: ${name} circuit is open`);
      }
      throw error;
    }
  };
}

/**
 * Create a fallback handler for circuit breaker
 */
export function setFallback<T>(
  breaker: CircuitBreaker,
  fallbackFn: (...args: unknown[]) => T | Promise<T>
): void {
  breaker.fallback(fallbackFn);
}

export default {
  createCircuitBreaker,
  getCircuitBreakerStatus,
  getElasticsearchSearchBreaker,
  getElasticsearchAutocompleteBreaker,
  getPostgresGeoBreaker,
  withCircuitBreaker,
  setFallback,
};
