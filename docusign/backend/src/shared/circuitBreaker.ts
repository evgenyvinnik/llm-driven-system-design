import CircuitBreaker from 'opossum';
import logger from './logger.js';
import { circuitBreakerState, circuitBreakerFailures } from './metrics.js';

// Circuit breaker states for metrics
const STATE_CLOSED = 0;
const STATE_OPEN = 1;
const STATE_HALF_OPEN = 2;

export interface CircuitBreakerOptions {
  timeout?: number;
  errorThresholdPercentage?: number;
  resetTimeout?: number;
  volumeThreshold?: number;
  name?: string;
}

export interface CircuitBreakerStats {
  failures: number;
  successes: number;
  rejects: number;
  timeouts: number;
  cacheHits: number;
  cacheMisses: number;
  semaphoreRejections: number;
  percentiles: Record<string, number>;
  latencyTimes: number[];
  latencyMean: number;
}

export interface CircuitBreakerHealth {
  state: 'open' | 'half-open' | 'closed';
  stats: CircuitBreakerStats;
}

export type CircuitBreakerWithState = CircuitBreaker & {
  opened: boolean;
  halfOpen: boolean;
  stats: CircuitBreakerStats;
};

// Default circuit breaker options
const defaultOptions: CircuitBreakerOptions = {
  timeout: 10000,           // 10 seconds timeout
  errorThresholdPercentage: 50,  // Open after 50% failures
  resetTimeout: 30000,      // Try again after 30 seconds
  volumeThreshold: 5,       // Minimum calls before tripping
};

// Store for all circuit breakers
const breakers = new Map<string, CircuitBreakerWithState>();

/**
 * Create a circuit breaker for an async operation
 * @param name - Name for the circuit breaker
 * @param fn - The async function to wrap
 * @param options - Circuit breaker options
 * @returns CircuitBreaker
 */
export function createCircuitBreaker<T extends unknown[], R>(
  name: string,
  fn: (...args: T) => Promise<R>,
  options: CircuitBreakerOptions = {}
): CircuitBreakerWithState {
  const mergedOptions = { ...defaultOptions, ...options, name };
  const breaker = new CircuitBreaker(fn, mergedOptions) as CircuitBreakerWithState;

  // Event handlers for logging and metrics
  breaker.on('success', () => {
    logger.debug({ breaker: name }, 'Circuit breaker call succeeded');
  });

  breaker.on('timeout', () => {
    logger.warn({ breaker: name }, 'Circuit breaker call timed out');
    circuitBreakerFailures.inc({ name });
  });

  breaker.on('reject', () => {
    logger.warn({ breaker: name }, 'Circuit breaker rejected call (circuit open)');
  });

  breaker.on('open', () => {
    logger.error({ breaker: name }, 'Circuit breaker opened');
    circuitBreakerState.set({ name }, STATE_OPEN);
  });

  breaker.on('halfOpen', () => {
    logger.info({ breaker: name }, 'Circuit breaker half-open, testing...');
    circuitBreakerState.set({ name }, STATE_HALF_OPEN);
  });

  breaker.on('close', () => {
    logger.info({ breaker: name }, 'Circuit breaker closed');
    circuitBreakerState.set({ name }, STATE_CLOSED);
  });

  breaker.on('fallback', () => {
    logger.info({ breaker: name }, 'Circuit breaker fallback executed');
  });

  breaker.on('failure', (error: Error) => {
    logger.error({ breaker: name, error: error.message }, 'Circuit breaker call failed');
    circuitBreakerFailures.inc({ name });
  });

  // Initialize metrics
  circuitBreakerState.set({ name }, STATE_CLOSED);

  breakers.set(name, breaker);
  return breaker;
}

/**
 * Get circuit breaker by name
 * @param name
 * @returns CircuitBreaker|undefined
 */
export function getCircuitBreaker(name: string): CircuitBreakerWithState | undefined {
  return breakers.get(name);
}

/**
 * Get health status of all circuit breakers
 * @returns Object
 */
export function getCircuitBreakerHealth(): Record<string, CircuitBreakerHealth> {
  const status: Record<string, CircuitBreakerHealth> = {};
  for (const [name, breaker] of breakers) {
    status[name] = {
      state: breaker.opened ? 'open' : (breaker.halfOpen ? 'half-open' : 'closed'),
      stats: breaker.stats,
    };
  }
  return status;
}

/**
 * Execute function with circuit breaker, with fallback
 * @param breaker
 * @param args - Arguments to pass to the function
 * @param fallback - Fallback function if circuit is open
 */
export async function executeWithFallback<T extends unknown[], R>(
  breaker: CircuitBreakerWithState,
  args: T,
  fallback?: (...args: T) => Promise<R>
): Promise<R> {
  return breaker.fire(...args).catch((err: Error) => {
    if (fallback) {
      logger.warn({ error: err.message }, 'Executing fallback');
      return fallback(...args);
    }
    throw err;
  }) as Promise<R>;
}

export default { createCircuitBreaker, getCircuitBreaker, getCircuitBreakerHealth, executeWithFallback };
