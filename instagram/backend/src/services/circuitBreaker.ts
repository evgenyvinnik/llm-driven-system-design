import CircuitBreaker from 'opossum';
import logger from './logger.js';
import { circuitBreakerState, circuitBreakerEvents } from './metrics.js';

/**
 * Circuit Breaker Factory
 *
 * Creates circuit breakers for protecting services from cascading failures.
 *
 * The circuit breaker pattern prevents an application from repeatedly
 * trying to execute an operation that's likely to fail, allowing it to:
 * - Continue without waiting for the fault to be fixed
 * - Detect whether the fault has been resolved
 *
 * States:
 * - CLOSED (0): Normal operation, requests flow through
 * - OPEN (1): Failures exceeded threshold, requests fail fast
 * - HALF-OPEN (2): Testing if the underlying service has recovered
 */

export interface CircuitBreakerOptions {
  timeout?: number;
  errorThresholdPercentage?: number;
  resetTimeout?: number;
  volumeThreshold?: number;
  rollingCountTimeout?: number;
  rollingCountBuckets?: number;
}

// Default circuit breaker options
const defaultOptions: CircuitBreakerOptions = {
  timeout: 10000, // 10 seconds - if function takes longer, trigger a failure
  errorThresholdPercentage: 50, // Open circuit if 50% of requests fail
  resetTimeout: 30000, // 30 seconds before trying again (half-open)
  volumeThreshold: 5, // Minimum number of requests before circuit can trip
  rollingCountTimeout: 10000, // Time in ms for the rolling stats window
  rollingCountBuckets: 10, // Number of buckets in the rolling window
};

export interface ServiceError extends Error {
  statusCode?: number;
  code?: string;
}

/**
 * Create a circuit breaker for a function
 */
export const createCircuitBreaker = <T extends unknown[], R>(
  name: string,
  fn: (...args: T) => Promise<R>,
  options: CircuitBreakerOptions = {}
): CircuitBreaker<T, R> => {
  const breaker = new CircuitBreaker<T, R>(fn, {
    ...defaultOptions,
    ...options,
    name,
  });

  // Track state changes for metrics
  const updateState = (state: number): void => {
    circuitBreakerState.labels(name).set(state);
  };

  // Event handlers for metrics and logging
  breaker.on('success', () => {
    circuitBreakerEvents.labels(name, 'success').inc();
  });

  breaker.on('failure', (error: Error) => {
    circuitBreakerEvents.labels(name, 'failure').inc();
    logger.warn(
      {
        circuitBreaker: name,
        event: 'failure',
        error: error.message,
      },
      `Circuit breaker ${name}: failure - ${error.message}`
    );
  });

  breaker.on('timeout', () => {
    circuitBreakerEvents.labels(name, 'timeout').inc();
    logger.warn(
      {
        circuitBreaker: name,
        event: 'timeout',
      },
      `Circuit breaker ${name}: timeout`
    );
  });

  breaker.on('reject', () => {
    circuitBreakerEvents.labels(name, 'reject').inc();
    logger.warn(
      {
        circuitBreaker: name,
        event: 'reject',
      },
      `Circuit breaker ${name}: rejected (circuit open)`
    );
  });

  breaker.on('open', () => {
    updateState(1); // OPEN
    circuitBreakerEvents.labels(name, 'open').inc();
    logger.error(
      {
        circuitBreaker: name,
        event: 'open',
      },
      `Circuit breaker ${name}: OPENED - too many failures`
    );
  });

  breaker.on('close', () => {
    updateState(0); // CLOSED
    circuitBreakerEvents.labels(name, 'close').inc();
    logger.info(
      {
        circuitBreaker: name,
        event: 'close',
      },
      `Circuit breaker ${name}: CLOSED - recovered`
    );
  });

  breaker.on('halfOpen', () => {
    updateState(2); // HALF-OPEN
    circuitBreakerEvents.labels(name, 'halfOpen').inc();
    logger.info(
      {
        circuitBreaker: name,
        event: 'halfOpen',
      },
      `Circuit breaker ${name}: HALF-OPEN - testing recovery`
    );
  });

  // Initialize state metric
  updateState(0);

  return breaker;
};

/**
 * Fallback function that returns a cached/default value
 */
export const fallbackWithDefault = <T>(defaultValue: T): ((error?: Error) => T) => {
  return (error?: Error): T => {
    logger.warn(
      {
        error: error?.message,
        fallback: 'default_value',
      },
      'Using fallback default value'
    );
    return defaultValue;
  };
};

/**
 * Fallback function that throws a user-friendly error
 */
export const fallbackWithError = (message: string): ((error?: Error) => never) => {
  return (error?: Error): never => {
    logger.error(
      {
        originalError: error?.message,
        fallback: 'error',
      },
      `Circuit breaker fallback: ${message}`
    );
    const serviceError: ServiceError = new Error(message);
    serviceError.statusCode = 503;
    serviceError.code = 'SERVICE_UNAVAILABLE';
    throw serviceError;
  };
};

export interface CircuitBreakerStats {
  failures: number;
  successes: number;
  timeouts: number;
  fallbacks: number;
  latencyMean?: number;
}

export interface CircuitBreakerInstance {
  opened: boolean;
  halfOpen: boolean;
  stats: CircuitBreakerStats;
}

export interface CircuitBreakerHealthStatus {
  state: 'closed' | 'open' | 'half-open';
  failures: number;
  successes: number;
  timeouts: number;
  fallbacks: number;
  latencyMean?: string;
}

/**
 * Health check for circuit breakers
 */
export const getCircuitBreakerHealth = (
  breakers: Record<string, CircuitBreakerInstance>
): Record<string, CircuitBreakerHealthStatus> => {
  const health: Record<string, CircuitBreakerHealthStatus> = {};
  for (const [name, breaker] of Object.entries(breakers)) {
    const stats = breaker.stats;
    health[name] = {
      state: breaker.opened ? (breaker.halfOpen ? 'half-open' : 'open') : 'closed',
      failures: stats.failures,
      successes: stats.successes,
      timeouts: stats.timeouts,
      fallbacks: stats.fallbacks,
      latencyMean: stats.latencyMean?.toFixed(2),
    };
  }
  return health;
};

export default createCircuitBreaker;
