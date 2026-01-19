/**
 * Circuit breaker implementation using opossum.
 *
 * WHY circuit breakers are CRITICAL for typeahead:
 * - Protects the search index from cascading failures
 * - Prevents thundering herd when recovering from failures
 * - Provides graceful degradation with fallback suggestions
 * - Enables fast-fail instead of slow timeouts
 */
import CircuitBreaker from 'opossum';
import logger, { auditLogger } from './logger.js';
import { circuitBreakerMetrics } from './metrics.js';

// Circuit breaker options interface
interface CircuitBreakerOptions {
  timeout?: number;
  errorThresholdPercentage?: number;
  resetTimeout?: number;
  volumeThreshold?: number;
}

// Circuit status interface
interface CircuitStatus {
  state: 'open' | 'half-open' | 'closed';
  stats: unknown;
  options: {
    timeout: number;
    errorThresholdPercentage: number;
    resetTimeout: number;
  };
}

// Default circuit breaker options
const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  timeout: 100, // 100ms timeout (typeahead needs to be fast)
  errorThresholdPercentage: 50, // Open circuit if 50% of requests fail
  resetTimeout: 10000, // Try again after 10 seconds
  volumeThreshold: 5, // Minimum requests before tripping
};

// Map to store circuit breakers by name
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const circuits = new Map<string, CircuitBreaker<any>>();

/**
 * Create or get a circuit breaker for a named operation
 */
export function createCircuitBreaker<T, A extends unknown[]>(
  name: string,
  action: (...args: A) => Promise<T>,
  options: CircuitBreakerOptions = {},
  fallback: ((...args: A) => Promise<T>) | null = null
): CircuitBreaker<T, A> {
  if (circuits.has(name)) {
    return circuits.get(name) as CircuitBreaker<T, A>;
  }

  const circuitOptions = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  const breaker = new CircuitBreaker(action, circuitOptions);

  // Setup event handlers for logging and metrics
  breaker.on('success', () => {
    circuitBreakerMetrics.state.set({ circuit_name: name }, 0); // 0 = closed
  });

  breaker.on('failure', (error: Error) => {
    logger.warn({
      event: 'circuit_failure',
      circuit: name,
      error: error?.message || 'unknown',
    });
    circuitBreakerMetrics.failures.inc({ circuit_name: name });
  });

  breaker.on('open', () => {
    auditLogger.logCircuitStateChange(name, 'closed', 'open', 'failure threshold exceeded');
    circuitBreakerMetrics.state.set({ circuit_name: name }, 2); // 2 = open
  });

  breaker.on('halfOpen', () => {
    auditLogger.logCircuitStateChange(name, 'open', 'half-open', 'reset timeout elapsed');
    circuitBreakerMetrics.state.set({ circuit_name: name }, 1); // 1 = half-open
  });

  breaker.on('close', () => {
    auditLogger.logCircuitStateChange(name, 'half-open', 'closed', 'successful request');
    circuitBreakerMetrics.state.set({ circuit_name: name }, 0); // 0 = closed
  });

  breaker.on('fallback', () => {
    logger.info({
      event: 'circuit_fallback',
      circuit: name,
    });
    circuitBreakerMetrics.fallbacks.inc({ circuit_name: name });
  });

  breaker.on('timeout', () => {
    logger.warn({
      event: 'circuit_timeout',
      circuit: name,
      timeout: circuitOptions.timeout,
    });
  });

  // Set fallback if provided
  if (fallback) {
    breaker.fallback(fallback);
  }

  // Initialize metrics
  circuitBreakerMetrics.state.set({ circuit_name: name }, 0);

  circuits.set(name, breaker);
  return breaker as CircuitBreaker<T, A>;
}

/**
 * Get circuit breaker by name
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getCircuitBreaker(name: string): CircuitBreaker<any> | undefined {
  return circuits.get(name);
}

/**
 * Get all circuit breaker statuses
 */
export function getCircuitStatus(): Record<string, CircuitStatus> {
  const status: Record<string, CircuitStatus> = {};
  for (const [name, breaker] of circuits) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const breakerAny = breaker as any;
    status[name] = {
      state: breaker.opened ? 'open' : breaker.halfOpen ? 'half-open' : 'closed',
      stats: breaker.stats,
      options: {
        timeout: breakerAny.options?.timeout ?? 0,
        errorThresholdPercentage: breakerAny.options?.errorThresholdPercentage ?? 0,
        resetTimeout: breakerAny.options?.resetTimeout ?? 0,
      },
    };
  }
  return status;
}

/**
 * Reset all circuits (for testing)
 */
export function resetAllCircuits(): void {
  for (const breaker of circuits.values()) {
    breaker.close();
  }
}

/**
 * Create a suggestion service circuit breaker
 * Used to wrap trie queries with circuit breaker protection
 */
export function createSuggestionCircuitBreaker<T, A extends unknown[]>(
  suggestionFn: (...args: A) => Promise<T>,
  fallbackFn: (...args: A) => Promise<T>
): CircuitBreaker<T, A> {
  return createCircuitBreaker(
    'suggestion_service',
    suggestionFn,
    {
      timeout: 50, // 50ms for suggestions (very tight)
      errorThresholdPercentage: 30, // Open if 30% fail
      resetTimeout: 5000, // Try again after 5 seconds
      volumeThreshold: 10, // Need at least 10 requests
    },
    fallbackFn
  );
}

/**
 * Create a database circuit breaker
 * Used to wrap PostgreSQL queries
 */
export function createDatabaseCircuitBreaker<T, A extends unknown[]>(
  dbFn: (...args: A) => Promise<T>,
  fallbackFn: (...args: A) => Promise<T>
): CircuitBreaker<T, A> {
  return createCircuitBreaker(
    'database',
    dbFn,
    {
      timeout: 1000, // 1 second for DB operations
      errorThresholdPercentage: 50,
      resetTimeout: 15000, // 15 seconds
      volumeThreshold: 5,
    },
    fallbackFn
  );
}

/**
 * Create a Redis circuit breaker
 * Used to wrap Redis cache operations
 */
export function createRedisCircuitBreaker<T, A extends unknown[]>(
  redisFn: (...args: A) => Promise<T>,
  fallbackFn: (...args: A) => Promise<T>
): CircuitBreaker<T, A> {
  return createCircuitBreaker(
    'redis_cache',
    redisFn,
    {
      timeout: 50, // 50ms for cache (fast fail)
      errorThresholdPercentage: 50,
      resetTimeout: 5000,
      volumeThreshold: 10,
    },
    fallbackFn
  );
}

export default {
  createCircuitBreaker,
  getCircuitBreaker,
  getCircuitStatus,
  resetAllCircuits,
  createSuggestionCircuitBreaker,
  createDatabaseCircuitBreaker,
  createRedisCircuitBreaker,
};
