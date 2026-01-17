/**
 * @fileoverview Circuit breaker implementation for Elasticsearch.
 * Protects the search service from cascading failures when ES is unavailable.
 * Uses the cockatiel library for resilience patterns.
 */

import {
  CircuitBreakerPolicy,
  ConsecutiveBreaker,
  circuitBreaker,
  handleAll,
  retry,
  wrap,
  TimeoutPolicy,
  timeout,
  TimeoutStrategy,
  ExponentialBackoff,
  CircuitState,
} from 'cockatiel';
import { logger, logCircuitBreakerStateChange } from './logger.js';
import {
  circuitBreakerState,
  circuitBreakerStateTotal,
} from './metrics.js';
import { CIRCUIT_BREAKER_THRESHOLDS } from './alertThresholds.js';

/**
 * Circuit breaker state values for metrics.
 */
const CIRCUIT_STATE_VALUES: Record<string, number> = {
  [CircuitState.Closed]: 0,
  [CircuitState.Open]: 1,
  [CircuitState.HalfOpen]: 2,
};

/**
 * Maps CircuitState enum to string for logging.
 */
function stateToString(state: CircuitState): 'open' | 'closed' | 'half_open' {
  switch (state) {
    case CircuitState.Open:
      return 'open';
    case CircuitState.HalfOpen:
      return 'half_open';
    case CircuitState.Closed:
    default:
      return 'closed';
  }
}

/**
 * Creates a circuit breaker policy for a service.
 * @param serviceName - Name of the service for logging and metrics
 * @returns Configured circuit breaker policy
 */
function createCircuitBreaker(serviceName: string): CircuitBreakerPolicy {
  const breaker = circuitBreaker(handleAll, {
    halfOpenAfter: CIRCUIT_BREAKER_THRESHOLDS.RESET_TIMEOUT_MS,
    breaker: new ConsecutiveBreaker(CIRCUIT_BREAKER_THRESHOLDS.FAILURE_THRESHOLD),
  });

  // Track state changes for monitoring
  breaker.onStateChange((state) => {
    const stateKey = stateToString(state);
    logCircuitBreakerStateChange(serviceName, stateKey);
    circuitBreakerStateTotal.inc({ service: serviceName, state: stateKey });
    circuitBreakerState.set(
      { service: serviceName },
      CIRCUIT_STATE_VALUES[state] ?? 0
    );
  });

  breaker.onBreak(() => {
    logger.warn(
      { service: serviceName },
      `Circuit breaker opened for ${serviceName} - service calls will fail fast`
    );
  });

  breaker.onReset(() => {
    logger.info(
      { service: serviceName },
      `Circuit breaker reset for ${serviceName} - service calls resuming`
    );
  });

  return breaker;
}

/**
 * Creates a timeout policy for service calls.
 * @param timeoutMs - Timeout in milliseconds
 * @returns Configured timeout policy
 */
function createTimeout(timeoutMs: number): TimeoutPolicy {
  return timeout(timeoutMs, TimeoutStrategy.Aggressive);
}

/**
 * Elasticsearch circuit breaker instance.
 * Opens after 5 consecutive failures, half-opens after 30 seconds.
 */
export const elasticsearchCircuitBreaker = createCircuitBreaker('elasticsearch');

/**
 * Elasticsearch timeout policy.
 * Times out requests after 5 seconds.
 */
export const elasticsearchTimeout = createTimeout(
  CIRCUIT_BREAKER_THRESHOLDS.REQUEST_TIMEOUT_MS
);

/**
 * Combined Elasticsearch resilience policy.
 * Applies timeout first, then circuit breaker.
 */
export const elasticsearchPolicy = wrap(
  elasticsearchTimeout,
  elasticsearchCircuitBreaker
);

/**
 * Retry policy for transient failures.
 * Retries up to 2 times with exponential backoff.
 */
export const retryPolicy = retry(handleAll, {
  maxAttempts: 3,
  backoff: new ExponentialBackoff({
    initialDelay: 100,
    maxDelay: 2000,
  }),
});

/**
 * Full resilience policy with retry, timeout, and circuit breaker.
 * Order: retry -> timeout -> circuit breaker
 * - Retry wraps the operation for transient failures
 * - Timeout prevents slow requests from blocking
 * - Circuit breaker prevents cascade failures
 */
export const fullElasticsearchPolicy = wrap(
  retryPolicy,
  elasticsearchTimeout,
  elasticsearchCircuitBreaker
);

/**
 * Executes a function with the Elasticsearch resilience policy.
 * @template T - Return type of the function
 * @param fn - Function to execute
 * @param fallback - Optional fallback value if all retries fail
 * @returns Promise resolving to the function result or fallback
 */
export async function executeWithCircuitBreaker<T>(
  fn: () => Promise<T>,
  fallback?: T
): Promise<T> {
  try {
    return await elasticsearchPolicy.execute(fn);
  } catch (error) {
    if (fallback !== undefined) {
      logger.warn(
        { error },
        'Elasticsearch call failed, returning fallback value'
      );
      return fallback;
    }
    throw error;
  }
}

/**
 * Checks if the Elasticsearch circuit breaker is open.
 * Useful for health checks and graceful degradation.
 * @returns True if circuit is open (service unavailable)
 */
export function isElasticsearchCircuitOpen(): boolean {
  return elasticsearchCircuitBreaker.state === CircuitState.Open;
}

/**
 * Gets the current state of the Elasticsearch circuit breaker.
 * @returns Current circuit state: 'closed', 'open', or 'halfOpen'
 */
export function getElasticsearchCircuitState(): string {
  return stateToString(elasticsearchCircuitBreaker.state);
}

/**
 * Error class for circuit breaker open state.
 * Thrown when the circuit is open and calls fail fast.
 */
export class CircuitOpenError extends Error {
  constructor(service: string) {
    super(`Circuit breaker is open for ${service}`);
    this.name = 'CircuitOpenError';
  }
}
