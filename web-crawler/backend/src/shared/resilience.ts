/**
 * @fileoverview Circuit breaker and retry utilities for resilient HTTP requests.
 *
 * Implements the circuit breaker pattern using cockatiel library to prevent
 * cascade failures when external domains are unresponsive or failing.
 *
 * WHY CIRCUIT BREAKERS:
 * When a target website goes down, naive retry logic wastes resources:
 * 1. Workers spend time on timeouts instead of crawling other domains
 * 2. Failing requests consume network connections and memory
 * 3. Overwhelming a struggling server prevents its recovery
 *
 * Circuit breakers "trip" after consecutive failures, immediately failing
 * subsequent requests without attempting the network call. After a cooldown,
 * a test request is allowed through (half-open state). If it succeeds,
 * normal operation resumes (closed state).
 *
 * WHY RETRY WITH EXPONENTIAL BACKOFF:
 * Transient failures (network blips, temporary overload) often resolve quickly.
 * Immediate retry may hit the same transient issue. Exponential backoff:
 * 1. Gives the target time to recover
 * 2. Reduces load during partial outages
 * 3. Jitter prevents thundering herd when many crawlers retry simultaneously
 *
 * @module shared/resilience
 */

import {
  CircuitBreakerPolicy,
  circuitBreaker,
  retry,
  handleWhen,
  ExponentialBackoff,
  ConsecutiveBreaker,
  wrap,
  IPolicy,
  RetryPolicy,
  CircuitState as CockatielCircuitState,
  BrokenCircuitError,
} from 'cockatiel';
import { redis } from '../models/redis.js';
import { circuitBreakerLogger } from './logger.js';
import {
  circuitBreakerStateGauge,
  circuitBreakerTransitionsCounter,
} from './metrics.js';

/**
 * Circuit breaker configuration.
 */
export interface CircuitBreakerConfig {
  /** Number of consecutive failures to open the circuit */
  failureThreshold: number;
  /** Time in ms to wait before trying again (half-open) */
  resetTimeoutMs: number;
  /** Number of successful requests in half-open to close the circuit */
  halfOpenSuccessThreshold: number;
}

/**
 * Default circuit breaker configuration.
 */
export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 60000, // 1 minute
  halfOpenSuccessThreshold: 2,
};

/**
 * Retry configuration.
 */
export interface RetryConfig {
  /** Maximum number of retry attempts */
  maxAttempts: number;
  /** Initial delay in ms */
  initialDelayMs: number;
  /** Maximum delay in ms */
  maxDelayMs: number;
  /** Backoff multiplier (2 = double each time) */
  multiplier: number;
}

/**
 * Default retry configuration with exponential backoff.
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  multiplier: 2,
};

/**
 * Cache of circuit breakers per domain.
 * Each domain gets its own circuit breaker to isolate failures.
 */
const domainCircuitBreakers = new Map<string, CircuitBreakerPolicy>();

/**
 * Circuit breaker state values for Redis storage.
 */
export enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half-open',
}

/**
 * Gets or creates a circuit breaker for a specific domain.
 *
 * Each domain has its own circuit breaker because:
 * 1. One failing domain shouldn't affect crawling of other domains
 * 2. Domains have independent failure modes and recovery times
 * 3. Metrics can be tracked per-domain for debugging
 *
 * @param domain - The domain to get/create circuit breaker for
 * @param config - Circuit breaker configuration
 * @returns The circuit breaker policy for the domain
 */
export function getCircuitBreaker(
  domain: string,
  config: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER_CONFIG
): CircuitBreakerPolicy {
  let cb = domainCircuitBreakers.get(domain);

  if (!cb) {
    // Only transient failures (network errors, 5xx) count toward opening the
    // circuit; a 404 or an oversized page says nothing about the host's health.
    cb = circuitBreaker(handleWhen(isRetryableError), {
      halfOpenAfter: config.resetTimeoutMs,
      breaker: new ConsecutiveBreaker(config.failureThreshold),
    });

    // Set up event listeners for metrics and logging
    cb.onStateChange((state: CockatielCircuitState) => {
      const stateValue =
        state === CockatielCircuitState.Closed ? 0 : state === CockatielCircuitState.HalfOpen ? 1 : 2;
      circuitBreakerStateGauge.labels(domain).set(stateValue);

      circuitBreakerLogger.info(
        { domain, state: toCircuitState(state) },
        `Circuit breaker state changed to ${state}`
      );

      // Store state in Redis for distributed awareness
      storeCircuitState(domain, toCircuitState(state), config.resetTimeoutMs).catch((err) => {
        circuitBreakerLogger.error({ err, domain }, 'Failed to store circuit state');
      });
    });

    cb.onBreak(() => {
      circuitBreakerTransitionsCounter.labels(domain, 'closed', 'open').inc();
      circuitBreakerLogger.warn({ domain }, 'Circuit breaker opened');
    });

    cb.onReset(() => {
      circuitBreakerTransitionsCounter.labels(domain, 'half-open', 'closed').inc();
      circuitBreakerLogger.info({ domain }, 'Circuit breaker reset (closed)');
    });

    cb.onHalfOpen(() => {
      circuitBreakerTransitionsCounter.labels(domain, 'open', 'half-open').inc();
      circuitBreakerLogger.info({ domain }, 'Circuit breaker half-open');
    });

    domainCircuitBreakers.set(domain, cb);
    circuitBreakerStateGauge.labels(domain).set(0); // Initial state: closed
  }

  return cb;
}

/**
 * Stores circuit breaker state in Redis for distributed coordination.
 * Other workers can check this before attempting requests.
 */
async function storeCircuitState(
  domain: string,
  state: CircuitState,
  resetTimeoutMs: number
): Promise<void> {
  const key = `crawler:circuit:${domain}`;

  if (state === CircuitState.CLOSED) {
    await redis.del(key);
    return;
  }

  // The shared OPEN flag lives exactly as long as the break duration. Other
  // workers skip the domain while it exists; once it expires, the next worker
  // to fetch acts as the half-open probe. (Previously this used a 1h TTL, and
  // since every worker skipped the domain without fetching, no breaker ever
  // reached half-open to clear it - the domain stayed blocked for the hour.)
  await redis.set(key, state, 'PX', Math.max(1000, resetTimeoutMs));
}

/**
 * Maps cockatiel's numeric CircuitState enum to our string enum.
 *
 * cockatiel's enum is numeric (Closed = 0, Open = 1, HalfOpen = 2, Isolated = 3).
 * The original code compared `state.toString()` against 'closed' / 'halfOpen',
 * which never matched ('0', '2'), so EVERY transition - including a reset back
 * to closed - was published to Redis as OPEN.
 */
export function toCircuitState(state: CockatielCircuitState): CircuitState {
  switch (state) {
    case CockatielCircuitState.Closed:
      return CircuitState.CLOSED;
    case CockatielCircuitState.HalfOpen:
      return CircuitState.HALF_OPEN;
    default:
      return CircuitState.OPEN;
  }
}

/**
 * Checks if a domain's circuit is open from Redis (distributed check).
 *
 * Workers can use this to skip domains that are failing across the cluster,
 * without waiting for their local circuit breaker to trip.
 *
 * @param domain - The domain to check
 * @returns True if circuit is open (should skip), false otherwise
 */
export async function isCircuitOpen(domain: string): Promise<boolean> {
  const key = `crawler:circuit:${domain}`;
  const state = await redis.get(key);
  return state === CircuitState.OPEN;
}

/**
 * Creates a retry policy with exponential backoff and jitter.
 *
 * @param config - Retry configuration
 * @returns Retry policy
 */
export function createRetryPolicy(
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): RetryPolicy {
  // Retry only transient errors; retrying a DNS-valid 'maxContentLength exceeded'
  // or a malformed URL just triples the load for the same outcome.
  return retry(handleWhen(isRetryableError), {
    maxAttempts: config.maxAttempts,
    backoff: new ExponentialBackoff({
      initialDelay: config.initialDelayMs,
      maxDelay: config.maxDelayMs,
      exponent: config.multiplier,
    }),
  });
}

/**
 * Creates a combined policy with retry and circuit breaker.
 *
 * The order matters: retry wraps circuit breaker.
 * This means if the circuit is open, retries won't happen (fail fast).
 * If the circuit is closed, retries happen on failures.
 *
 * @param domain - The domain for the circuit breaker
 * @param retryConfig - Retry configuration
 * @param cbConfig - Circuit breaker configuration
 * @returns Combined policy
 */
export function createResilientPolicy(
  domain: string,
  retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG,
  cbConfig: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER_CONFIG
): IPolicy {
  const retryPolicy = createRetryPolicy(retryConfig);
  const circuitBreakerPolicy = getCircuitBreaker(domain, cbConfig);

  // Wrap: retry will retry failed attempts, but respects circuit breaker
  return wrap(retryPolicy, circuitBreakerPolicy);
}

/**
 * Executes a function with retry and circuit breaker protection.
 *
 * @param domain - The domain for circuit breaker isolation
 * @param fn - The async function to execute
 * @param retryConfig - Retry configuration
 * @param cbConfig - Circuit breaker configuration
 * @returns The result of the function
 * @throws If all retries fail or circuit is open
 *
 * @example
 * ```typescript
 * const result = await withResilience(
 *   'example.com',
 *   () => axios.get('https://example.com/page'),
 *   { maxAttempts: 3 }
 * );
 * ```
 */
export async function withResilience<T>(
  domain: string,
  fn: () => Promise<T>,
  retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG,
  cbConfig: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER_CONFIG
): Promise<T> {
  const policy = createResilientPolicy(domain, retryConfig, cbConfig);
  return policy.execute(fn);
}

/**
 * Clears all cached circuit breakers.
 * Useful for testing or when resetting state.
 */
export function clearCircuitBreakers(): void {
  domainCircuitBreakers.clear();
}

/**
 * Gets the current state of a domain's circuit breaker.
 *
 * @param domain - The domain to check
 * @returns The circuit state, or 'closed' if no breaker exists
 */
export function getCircuitState(domain: string): 'closed' | 'open' | 'halfOpen' {
  const cb = domainCircuitBreakers.get(domain);
  if (!cb) return 'closed';

  switch (cb.state) {
    case CockatielCircuitState.Closed:
      return 'closed';
    case CockatielCircuitState.Open:
      return 'open';
    case CockatielCircuitState.HalfOpen:
      return 'halfOpen';
    default:
      return 'closed';
  }
}

/**
 * Error class for circuit breaker open state.
 * Thrown when a request is rejected because the circuit is open.
 */
export class CircuitOpenError extends Error {
  constructor(public readonly domain: string) {
    super(`Circuit breaker is open for domain: ${domain}`);
    this.name = 'CircuitOpenError';
  }
}

/**
 * Utility to check if an error is a circuit open error - either our own
 * CircuitOpenError or cockatiel's BrokenCircuitError (thrown by the policy
 * when the in-process breaker is open).
 */
export function isCircuitOpenError(error: unknown): boolean {
  return error instanceof CircuitOpenError || error instanceof BrokenCircuitError;
}

/**
 * Determines if an error is retryable.
 *
 * @param error - The error to check
 * @returns True if the error is transient and can be retried
 */
export function isRetryableError(error: unknown): boolean {
  if (!error) return false;

  // Check for common transient error codes
  const errorObj = error as { code?: string; response?: { status?: number } };

  const retryableCodes = [
    'ECONNABORTED', // axios request timeout
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EPIPE',
    'EHOSTUNREACH',
    'ENETUNREACH',
  ];

  if (errorObj.code && retryableCodes.includes(errorObj.code)) {
    return true;
  }

  // Retry on 5xx server errors
  if (errorObj.response?.status && errorObj.response.status >= 500) {
    return true;
  }

  return false;
}
