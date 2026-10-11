import CircuitBreaker from 'opossum';
import { createModuleLogger } from './logger.js';
import { metrics } from './metrics.js';

const logger = createModuleLogger('circuit-breaker');

// Circuit breaker state mapping for metrics
const STATE_MAP: Record<string, number> = {
  'closed': 0,
  'halfOpen': 1,
  'open': 2
};

/**
 * Create a circuit breaker around sandbox container runs.
 *
 * The circuit breaker protects the system from cascading failures when the
 * Docker daemon is unavailable or hanging. Only infrastructure failures reject
 * the wrapped function; a user's infinite loop or crash is a normal result
 * (a verdict), so it never trips the breaker.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Failures exceeded threshold, all requests fail fast with EOPENBREAKER
 * - HALF-OPEN: After the reset timeout, a trial request tests whether Docker recovered
 *
 * No fallback is registered on purpose: opossum calls a fallback for every failure, not
 * only when the circuit is open, which used to make any Docker error look like "breaker open".
 */
export function createExecutionCircuitBreaker<TArg, TResult>(
  executeFn: (arg: TArg) => Promise<TResult>
): CircuitBreaker<[TArg], TResult> {
  const breaker = new CircuitBreaker(executeFn, {
    // Open when half of the recent container runs failed...
    errorThresholdPercentage: 50,
    // ...once at least 5 runs are in the rolling window
    volumeThreshold: 5,
    // Wait 30 seconds before trying again when open
    resetTimeout: 30000,
    // Backstop timeout; the executor enforces its own per-container deadlines
    timeout: 60000,
    // Allow 3 concurrent requests during half-open state
    allowWarmUp: true,
    // Cache the response
    cache: false,
    // Rolling window for statistics
    rollingCountTimeout: 10000,
    rollingCountBuckets: 10,
    // Name for logging and metrics
    name: 'code-executor'
  });

  // Update metrics on state change
  breaker.on('open', () => {
    logger.warn({ state: 'open' }, 'Circuit breaker opened - code execution temporarily unavailable');
    metrics.circuitBreakerState.set({ name: 'code-executor' }, STATE_MAP.open);
    metrics.circuitBreakerEvents.inc({ name: 'code-executor', event: 'open' });
  });

  breaker.on('halfOpen', () => {
    logger.info({ state: 'halfOpen' }, 'Circuit breaker half-open - testing if service recovered');
    metrics.circuitBreakerState.set({ name: 'code-executor' }, STATE_MAP.halfOpen);
    metrics.circuitBreakerEvents.inc({ name: 'code-executor', event: 'halfOpen' });
  });

  breaker.on('close', () => {
    logger.info({ state: 'closed' }, 'Circuit breaker closed - code execution service recovered');
    metrics.circuitBreakerState.set({ name: 'code-executor' }, STATE_MAP.closed);
    metrics.circuitBreakerEvents.inc({ name: 'code-executor', event: 'close' });
  });

  breaker.on('success', () => {
    metrics.circuitBreakerEvents.inc({ name: 'code-executor', event: 'success' });
  });

  breaker.on('failure', (error: Error) => {
    logger.error({ error: error.message }, 'Circuit breaker recorded failure');
    metrics.circuitBreakerEvents.inc({ name: 'code-executor', event: 'failure' });
  });

  breaker.on('reject', () => {
    logger.warn('Request rejected - circuit breaker is open');
    metrics.circuitBreakerEvents.inc({ name: 'code-executor', event: 'reject' });
  });

  breaker.on('timeout', () => {
    metrics.circuitBreakerEvents.inc({ name: 'code-executor', event: 'timeout' });
  });

  // Initialize metrics
  metrics.circuitBreakerState.set({ name: 'code-executor' }, STATE_MAP.closed);

  return breaker;
}
