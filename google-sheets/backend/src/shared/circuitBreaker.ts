/**
 * Circuit breaker module for resilient external service calls.
 * Implements the circuit breaker pattern to prevent cascading failures
 * when downstream services (Redis pub/sub, external APIs) are degraded.
 *
 * WHY: In collaborative applications, when Redis pub/sub fails, we don't
 * want to block cell edits. The circuit breaker allows edits to succeed
 * locally while gracefully degrading real-time sync. When the circuit
 * opens, we log the failure and allow the system to recover.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Service is failing, requests fail fast
 * - HALF-OPEN: Testing if service has recovered
 *
 * @module shared/circuitBreaker
 */

import CircuitBreaker from 'opossum';
import logger from './logger.js';
import { circuitBreakerState, circuitBreakerFallbacks } from './metrics.js';

/**
 * Circuit breaker configuration options
 */
export interface CircuitBreakerOptions {
  /** Timeout for each request in milliseconds (default: 5000) */
  timeout?: number;
  /** Error percentage threshold to open circuit (default: 50) */
  errorThresholdPercentage?: number;
  /** Time to wait before testing if service recovered (default: 10000) */
  resetTimeout?: number;
  /** Minimum number of requests before calculating error percentage (default: 5) */
  volumeThreshold?: number;
}

/**
 * Circuit state enum for metrics
 */
enum CircuitState {
  CLOSED = 0,
  OPEN = 1,
  HALF_OPEN = 2,
}

/**
 * Creates a circuit breaker for an async function.
 * Automatically handles fallback, logging, and metrics.
 *
 * @example
 * const protectedPublish = createCircuitBreaker(
 *   'redis-pubsub',
 *   async (channel, message) => redis.publish(channel, message),
 *   { timeout: 1000 }
 * );
 *
 * // Use the protected function
 * await protectedPublish.fire(channel, message);
 *
 * @param name - Unique name for this circuit breaker (used in logs and metrics)
 * @param action - The async function to protect
 * @param options - Circuit breaker configuration options
 * @returns The configured circuit breaker instance
 */
export function createCircuitBreaker<TArgs extends any[], TResult>(
  name: string,
  action: (...args: TArgs) => Promise<TResult>,
  options: CircuitBreakerOptions = {}
): CircuitBreaker<TArgs, TResult> {
  const breaker = new CircuitBreaker(action, {
    timeout: options.timeout ?? 5000,
    errorThresholdPercentage: options.errorThresholdPercentage ?? 50,
    resetTimeout: options.resetTimeout ?? 10000,
    volumeThreshold: options.volumeThreshold ?? 5,
    name,
  });

  // Event handlers for logging and metrics
  breaker.on('open', () => {
    logger.error({ breaker: name }, 'Circuit breaker OPEN - failing fast');
    circuitBreakerState.labels(name).set(CircuitState.OPEN);
  });

  breaker.on('halfOpen', () => {
    logger.info({ breaker: name }, 'Circuit breaker HALF-OPEN - testing recovery');
    circuitBreakerState.labels(name).set(CircuitState.HALF_OPEN);
  });

  breaker.on('close', () => {
    logger.info({ breaker: name }, 'Circuit breaker CLOSED - normal operation');
    circuitBreakerState.labels(name).set(CircuitState.CLOSED);
  });

  breaker.on('fallback', () => {
    circuitBreakerFallbacks.labels(name).inc();
    logger.warn({ breaker: name }, 'Circuit breaker fallback invoked');
  });

  breaker.on('timeout', () => {
    logger.warn({ breaker: name }, 'Circuit breaker request timed out');
  });

  breaker.on('reject', () => {
    logger.debug({ breaker: name }, 'Circuit breaker request rejected (circuit open)');
  });

  // Initialize metrics
  circuitBreakerState.labels(name).set(CircuitState.CLOSED);

  return breaker;
}

/**
 * Redis Pub/Sub circuit breaker for collaborative sync.
 * Used to protect real-time collaboration broadcasts.
 *
 * Configuration rationale:
 * - 1 second timeout: Pub/sub should be fast, slow = degraded
 * - 50% error threshold: Open quickly when Redis is down
 * - 10 second reset: Give Redis time to recover
 * - 3 volume threshold: Open faster in low-traffic scenarios
 */
export function createPubSubBreaker(
  publishFn: (channel: string, message: string) => Promise<number>
): CircuitBreaker<[string, string], number> {
  const breaker = createCircuitBreaker('redis-pubsub', publishFn, {
    timeout: 1000,
    errorThresholdPercentage: 50,
    resetTimeout: 10000,
    volumeThreshold: 3,
  });

  // Fallback: Log and return 0 (no subscribers)
  // The system continues working in single-server mode
  breaker.fallback(() => {
    logger.warn('Redis pub/sub unavailable - operating in single-server mode');
    return 0;
  });

  return breaker;
}

/**
 * Database circuit breaker for query operations.
 * Protects against database overload or connection issues.
 *
 * Configuration rationale:
 * - 5 second timeout: Allow for complex queries
 * - 50% error threshold: Standard threshold
 * - 10 second reset: Give database time to recover
 * - 5 volume threshold: Avoid false positives
 */
export function createDbBreaker<T>(
  queryFn: () => Promise<T>
): CircuitBreaker<[], T> {
  const breaker = createCircuitBreaker('database', queryFn, {
    timeout: 5000,
    errorThresholdPercentage: 50,
    resetTimeout: 10000,
    volumeThreshold: 5,
  });

  return breaker;
}

/**
 * WebSocket broadcast circuit breaker.
 * Protects against slow or failing broadcast operations.
 */
export function createBroadcastBreaker(
  broadcastFn: (spreadsheetId: string, message: any) => Promise<void>
): CircuitBreaker<[string, any], void> {
  const breaker = createCircuitBreaker('ws-broadcast', broadcastFn, {
    timeout: 2000,
    errorThresholdPercentage: 50,
    resetTimeout: 5000,
    volumeThreshold: 5,
  });

  // Fallback: Silent failure - clients will eventually resync
  breaker.fallback(() => {
    logger.warn('WebSocket broadcast failed - clients may be out of sync');
    return Promise.resolve();
  });

  return breaker;
}

/**
 * Gets the current state of a circuit breaker.
 * Useful for health checks and status pages.
 *
 * @param breaker - The circuit breaker to check
 * @returns Current state as a string
 */
export function getCircuitState(
  breaker: CircuitBreaker<any, any>
): 'closed' | 'open' | 'half-open' {
  if (breaker.opened) {
    return breaker.pendingClose ? 'half-open' : 'open';
  }
  return 'closed';
}

export default {
  createCircuitBreaker,
  createPubSubBreaker,
  createDbBreaker,
  createBroadcastBreaker,
  getCircuitState,
};
