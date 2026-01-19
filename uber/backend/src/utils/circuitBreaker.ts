import CircuitBreaker from 'opossum';
import { createLogger } from './logger.js';
import { metrics } from './metrics.js';

const logger = createLogger('circuit-breaker');

// Circuit breaker options interface
interface CircuitBreakerOptions {
  timeout?: number;
  errorThresholdPercentage?: number;
  resetTimeout?: number;
  volumeThreshold?: number;
}

// Default options for circuit breakers
const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  timeout: 5000, // 5 second timeout
  errorThresholdPercentage: 50, // Open after 50% failures
  resetTimeout: 30000, // Try again after 30 seconds
  volumeThreshold: 5, // Minimum 5 requests before tripping
};

// Circuit breaker stats interface
interface CircuitBreakerStats {
  successes: number;
  failures: number;
  rejects: number;
  timeouts: number;
  fallbacks: number;
}

// Circuit breaker status interface
interface CircuitBreakerStatusInfo {
  state: 'open' | 'closed' | 'half-open';
  stats: CircuitBreakerStats;
}

// Store active circuit breakers for monitoring
const circuitBreakers: Map<string, CircuitBreaker<unknown[], unknown>> = new Map();

/**
 * Create a circuit breaker for a given function
 * @param fn - The function to wrap
 * @param name - Name for logging and metrics
 * @param options - Circuit breaker options
 * @returns CircuitBreaker instance
 */
export function createCircuitBreaker<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  name: string,
  options: CircuitBreakerOptions = {}
): CircuitBreaker<TArgs, TReturn> {
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };

  const breaker = new CircuitBreaker<TArgs, TReturn>(fn, mergedOptions);

  // Event handlers for logging and metrics
  breaker.on('open', () => {
    logger.warn({ circuit: name }, 'Circuit breaker OPENED - requests will be rejected');
    metrics.circuitBreakerState.set({ circuit: name, state: 'open' }, 1);
    metrics.circuitBreakerState.set({ circuit: name, state: 'closed' }, 0);
    metrics.circuitBreakerState.set({ circuit: name, state: 'half_open' }, 0);
  });

  breaker.on('halfOpen', () => {
    logger.info({ circuit: name }, 'Circuit breaker HALF-OPEN - testing with next request');
    metrics.circuitBreakerState.set({ circuit: name, state: 'open' }, 0);
    metrics.circuitBreakerState.set({ circuit: name, state: 'closed' }, 0);
    metrics.circuitBreakerState.set({ circuit: name, state: 'half_open' }, 1);
  });

  breaker.on('close', () => {
    logger.info({ circuit: name }, 'Circuit breaker CLOSED - normal operation resumed');
    metrics.circuitBreakerState.set({ circuit: name, state: 'open' }, 0);
    metrics.circuitBreakerState.set({ circuit: name, state: 'closed' }, 1);
    metrics.circuitBreakerState.set({ circuit: name, state: 'half_open' }, 0);
  });

  breaker.on('success', () => {
    metrics.circuitBreakerRequests.inc({ circuit: name, result: 'success' });
  });

  breaker.on('failure', (error: Error) => {
    logger.error({ circuit: name, error: error.message }, 'Circuit breaker recorded failure');
    metrics.circuitBreakerRequests.inc({ circuit: name, result: 'failure' });
  });

  breaker.on('timeout', () => {
    logger.warn({ circuit: name }, 'Circuit breaker request timed out');
    metrics.circuitBreakerRequests.inc({ circuit: name, result: 'timeout' });
  });

  breaker.on('reject', () => {
    logger.warn({ circuit: name }, 'Circuit breaker rejected request (circuit open)');
    metrics.circuitBreakerRequests.inc({ circuit: name, result: 'rejected' });
  });

  breaker.on('fallback', () => {
    metrics.circuitBreakerRequests.inc({ circuit: name, result: 'fallback' });
  });

  // Initialize metrics
  metrics.circuitBreakerState.set({ circuit: name, state: 'closed' }, 1);
  metrics.circuitBreakerState.set({ circuit: name, state: 'open' }, 0);
  metrics.circuitBreakerState.set({ circuit: name, state: 'half_open' }, 0);

  circuitBreakers.set(name, breaker as CircuitBreaker<unknown[], unknown>);

  return breaker;
}

/**
 * Get circuit breaker status for health checks
 * @returns Status of all circuit breakers
 */
export function getCircuitBreakerStatus(): Record<string, CircuitBreakerStatusInfo> {
  const status: Record<string, CircuitBreakerStatusInfo> = {};

  for (const [name, breaker] of circuitBreakers) {
    const breakerStats = breaker.stats as {
      successes: number;
      failures: number;
      rejects: number;
      timeouts: number;
      fallbacks: number;
    };

    status[name] = {
      state: breaker.opened ? 'open' : breaker.halfOpen ? 'half-open' : 'closed',
      stats: {
        successes: breakerStats.successes,
        failures: breakerStats.failures,
        rejects: breakerStats.rejects,
        timeouts: breakerStats.timeouts,
        fallbacks: breakerStats.fallbacks,
      },
    };
  }

  return status;
}

/**
 * Create circuit breaker with fallback
 * @param fn - The function to wrap
 * @param name - Name for logging and metrics
 * @param fallbackFn - Fallback function when circuit is open
 * @param options - Circuit breaker options
 * @returns CircuitBreaker instance
 */
export function createCircuitBreakerWithFallback<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  name: string,
  fallbackFn: (...args: TArgs) => TReturn | Promise<TReturn>,
  options: CircuitBreakerOptions = {}
): CircuitBreaker<TArgs, TReturn> {
  const breaker = createCircuitBreaker(fn, name, options);
  breaker.fallback(fallbackFn);
  return breaker;
}

// Retry options interface
interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  retryOn?: (error: Error) => boolean;
  onRetry?: (attempt: number, delay: number, error: Error) => void;
}

/**
 * Retry wrapper with exponential backoff
 * @param fn - Async function to retry
 * @param options - Retry options
 * @returns Result of the function
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelay = 100, // 100ms base delay
    maxDelay = 5000, // 5 second max delay
    retryOn = () => true, // Retry on all errors by default
    onRetry = null,
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt === maxRetries || !retryOn(lastError)) {
        throw error;
      }

      // Exponential backoff with jitter
      const delay = Math.min(
        baseDelay * Math.pow(2, attempt) + Math.random() * 100,
        maxDelay
      );

      if (onRetry) {
        onRetry(attempt + 1, delay, lastError);
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

export default { createCircuitBreaker, createCircuitBreakerWithFallback, withRetry, getCircuitBreakerStatus };
