import {
  ConsecutiveBreaker,
  ExponentialBackoff,
  retry,
  handleAll,
  wrap,
  circuitBreaker,
} from 'cockatiel';
import { logger } from './logger.js';
import { circuitBreakerState, circuitBreakerEvents } from './metrics.js';

/**
 * Circuit breaker and retry utilities for external service calls.
 *
 * CRITICAL: Payment processors can experience outages. Without circuit breakers:
 * - All requests queue up waiting for timeouts
 * - System becomes unresponsive
 * - Cascading failures affect other services
 *
 * With circuit breakers:
 * - Fast fail after threshold reached
 * - System remains responsive for cached/local operations
 * - Automatic recovery when processor comes back online
 */

// ============================================================================
// Circuit Breaker Configuration
// ============================================================================

/**
 * Circuit breaker states for logging and metrics:
 * - CLOSED: Normal operation, requests pass through
 * - HALF_OPEN: Testing if service recovered
 * - OPEN: Failing fast, not calling the service
 */
type CircuitState = 'closed' | 'half-open' | 'open';

/**
 * Creates a circuit breaker for a named service.
 *
 * Configuration:
 * - Opens after 5 consecutive failures
 * - Half-open after 30 seconds
 * - Closes after 2 successful requests
 *
 * @param serviceName - Name for metrics and logging (e.g., 'processor', 'fraud')
 * @returns Configured circuit breaker policy
 */
export function createCircuitBreaker(serviceName: string) {
  // Use consecutive breaker: opens after N consecutive failures
  const breaker = new ConsecutiveBreaker(5);

  const policy = circuitBreaker(handleAll, {
    breaker,
    halfOpenAfter: 30_000, // 30 seconds before attempting recovery
  });

  // Track state changes for metrics and logging
  let currentState: CircuitState = 'closed';

  policy.onStateChange((state) => {
    const stateMap: Record<string, CircuitState> = {
      closed: 'closed',
      halfOpen: 'half-open',
      open: 'open',
    };
    currentState = stateMap[state] || 'closed';

    // Update Prometheus gauge
    const stateValue = { closed: 0, 'half-open': 1, open: 2 }[currentState];
    circuitBreakerState.labels(serviceName).set(stateValue);
    circuitBreakerEvents.labels(serviceName, 'state_change').inc();

    logger.warn(
      { service: serviceName, state: currentState },
      `Circuit breaker state changed to ${currentState}`
    );
  });

  policy.onSuccess(() => {
    circuitBreakerEvents.labels(serviceName, 'success').inc();
  });

  policy.onFailure(() => {
    circuitBreakerEvents.labels(serviceName, 'failure').inc();
    logger.warn({ service: serviceName }, `Circuit breaker recorded failure`);
  });

  return {
    policy,
    getState: () => currentState,
  };
}

// ============================================================================
// Retry Policy Configuration
// ============================================================================

/**
 * Creates a retry policy with exponential backoff.
 *
 * IMPORTANT: Only use for idempotent operations!
 * Non-idempotent operations can cause duplicate processing.
 *
 * Default configuration:
 * - Max 3 attempts
 * - Initial delay: 100ms
 * - Max delay: 10s
 * - Exponential factor: 2
 *
 * @param options - Optional configuration overrides
 * @returns Retry policy
 */
export function createRetryPolicy(options?: {
  maxAttempts?: number;
  initialDelay?: number;
  maxDelay?: number;
}) {
  const { maxAttempts = 3, initialDelay = 100, maxDelay = 10_000 } = options || {};

  return retry(handleAll, {
    maxAttempts,
    backoff: new ExponentialBackoff({
      initialDelay,
      maxDelay,
    }),
  });
}

// ============================================================================
// Pre-configured Service Policies
// ============================================================================

/**
 * Circuit breaker for payment processor calls.
 *
 * WHY: Payment processors can experience:
 * - Network outages
 * - Rate limiting
 * - Maintenance windows
 * - DDoS protection triggers
 *
 * Without protection, a processor outage would:
 * - Block all payment requests
 * - Exhaust connection pools
 * - Cause timeout cascades
 */
export const processorCircuitBreaker = createCircuitBreaker('processor');

/**
 * Circuit breaker for fraud detection service.
 * More lenient than processor since fraud is advisory, not blocking.
 */
export const fraudCircuitBreaker = createCircuitBreaker('fraud');

/**
 * Circuit breaker for webhook delivery.
 * Per-merchant breakers would be ideal but this is a global fallback.
 */
export const webhookCircuitBreaker = createCircuitBreaker('webhook');

/**
 * Combined policy: Circuit breaker + Retry with exponential backoff.
 * Use for critical external calls that should retry on transient failures.
 *
 * @param serviceName - Name for the circuit breaker
 * @param fn - Async function to wrap
 * @returns Wrapped function with resilience policies
 */
export function withResilience<T extends (...args: never[]) => Promise<unknown>>(
  serviceName: string,
  fn: T
): T {
  const breaker = createCircuitBreaker(serviceName);
  const retryPolicy = createRetryPolicy();

  // Wrap with retry first, then circuit breaker
  const wrapped = wrap(retryPolicy, breaker.policy);

  return (async (...args: Parameters<T>) => {
    return wrapped.execute(() => fn(...args));
  }) as T;
}

/**
 * Wraps a function with retry logic only (no circuit breaker).
 * Use for operations that should retry but don't need circuit breaking.
 *
 * @param fn - Async function to wrap
 * @param options - Retry configuration
 * @returns Wrapped function with retry policy
 */
export function withRetry<T extends (...args: never[]) => Promise<unknown>>(
  fn: T,
  options?: Parameters<typeof createRetryPolicy>[0]
): T {
  const retryPolicy = createRetryPolicy(options);

  return (async (...args: Parameters<T>) => {
    return retryPolicy.execute(() => fn(...args));
  }) as T;
}
