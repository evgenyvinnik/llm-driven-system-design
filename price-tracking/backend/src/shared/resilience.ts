/**
 * Circuit breaker and retry logic for scraping operations.
 * Uses the cockatiel library for resilience patterns.
 *
 * Circuit Breaker: Prevents overwhelming target sites when they're having issues.
 * Opens after consecutive failures, allowing the site to recover before retrying.
 *
 * Retry with Exponential Backoff: Handles transient failures like network timeouts
 * by retrying with increasing delays, avoiding thundering herd problems.
 *
 * @module shared/resilience
 */
import {
  CircuitBreakerPolicy,
  ConsecutiveBreaker,
  ExponentialBackoff,
  handleAll,
  retry,
  circuitBreaker,
  wrap,
  CircuitState,
  RetryPolicy,
} from 'cockatiel';
import logger, { logCircuitBreaker } from '../utils/logger.js';
import {
  circuitBreakerState,
  circuitBreakerTransitions,
  scrapeRetries,
} from './metrics.js';

/**
 * Configuration for the circuit breaker.
 * These values can be overridden via environment variables.
 */
export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening the circuit */
  failureThreshold: number;
  /** Time in milliseconds before attempting to close a half-open circuit */
  halfOpenAfterMs: number;
}

/**
 * Configuration for retry with exponential backoff.
 */
export interface RetryConfig {
  /** Maximum number of retry attempts */
  maxRetries: number;
  /** Initial delay in milliseconds before first retry */
  initialDelayMs: number;
  /** Maximum delay cap in milliseconds */
  maxDelayMs: number;
  /** Multiplier for each subsequent retry delay */
  backoffMultiplier: number;
}

/**
 * Default circuit breaker configuration.
 * Opens after 5 consecutive failures, tries again after 60 seconds.
 */
const defaultCircuitConfig: CircuitBreakerConfig = {
  failureThreshold: parseInt(process.env.CIRCUIT_FAILURE_THRESHOLD || '5', 10),
  halfOpenAfterMs: parseInt(process.env.CIRCUIT_HALF_OPEN_MS || '60000', 10),
};

/**
 * Default retry configuration.
 * 3 retries with exponential backoff starting at 1 second, max 30 seconds.
 */
const defaultRetryConfig: RetryConfig = {
  maxRetries: parseInt(process.env.SCRAPE_MAX_RETRIES || '3', 10),
  initialDelayMs: parseInt(process.env.SCRAPE_RETRY_INITIAL_DELAY_MS || '1000', 10),
  maxDelayMs: parseInt(process.env.SCRAPE_RETRY_MAX_DELAY_MS || '30000', 10),
  backoffMultiplier: parseFloat(process.env.SCRAPE_RETRY_MULTIPLIER || '2'),
};

/**
 * Map of domain-specific circuit breakers.
 * Each domain gets its own circuit to allow independent failure handling.
 */
const domainCircuits = new Map<string, CircuitBreakerPolicy>();

/**
 * Map of domain-specific retry policies.
 */
const domainRetryPolicies = new Map<string, RetryPolicy>();

/**
 * Gets or creates a circuit breaker for a specific domain.
 * Each domain has its own circuit to isolate failures.
 *
 * @param domain - The domain to get a circuit breaker for
 * @param config - Optional configuration override
 * @returns The circuit breaker policy for the domain
 */
export function getCircuitBreaker(
  domain: string,
  config: CircuitBreakerConfig = defaultCircuitConfig
): CircuitBreakerPolicy {
  const existing = domainCircuits.get(domain);
  if (existing) {
    return existing;
  }

  const circuit = circuitBreaker(handleAll, {
    halfOpenAfter: config.halfOpenAfterMs,
    breaker: new ConsecutiveBreaker(config.failureThreshold),
  });

  // Track state changes
  circuit.onStateChange((state) => {
    const stateValue = state === CircuitState.Closed ? 0 : state === CircuitState.HalfOpen ? 1 : 2;
    circuitBreakerState.labels(domain).set(stateValue);

    const stateStr = state === CircuitState.Closed ? 'closed' : state === CircuitState.HalfOpen ? 'half-open' : 'open';
    logger.info({ domain, state: stateStr, action: 'circuit_state_change' }, `Circuit breaker state: ${stateStr}`);
  });

  // Track when circuit opens
  circuit.onBreak(() => {
    circuitBreakerTransitions.labels(domain, 'closed', 'open').inc();
    logCircuitBreaker(domain, 'closed', 'open', 'failure threshold reached');
  });

  // Track when circuit resets
  circuit.onReset(() => {
    circuitBreakerTransitions.labels(domain, 'half-open', 'closed').inc();
    logCircuitBreaker(domain, 'half-open', 'closed', 'successful test request');
  });

  // Track half-open attempts
  circuit.onHalfOpen(() => {
    circuitBreakerTransitions.labels(domain, 'open', 'half-open').inc();
    logCircuitBreaker(domain, 'open', 'half-open', 'testing recovery');
  });

  domainCircuits.set(domain, circuit);
  circuitBreakerState.labels(domain).set(0); // Initialize as closed

  return circuit;
}

/**
 * Gets or creates a retry policy for a specific domain.
 *
 * @param domain - The domain (for logging/metrics)
 * @param config - Optional configuration override
 * @returns The retry policy for the domain
 */
export function getRetryPolicy(
  domain: string,
  config: RetryConfig = defaultRetryConfig
): RetryPolicy {
  const existing = domainRetryPolicies.get(domain);
  if (existing) {
    return existing;
  }

  const retryPolicy = retry(handleAll, {
    maxAttempts: config.maxRetries,
    backoff: new ExponentialBackoff({
      initialDelay: config.initialDelayMs,
      maxDelay: config.maxDelayMs,
      exponent: config.backoffMultiplier,
    }),
  });

  retryPolicy.onRetry((event) => {
    const attempt = event.attempt;
    scrapeRetries.labels(domain, String(attempt)).inc();

    const errorMessage = 'error' in event ? (event.error as Error)?.message : 'Unknown error';

    logger.warn(
      {
        domain,
        attempt,
        error: errorMessage,
        action: 'scrape_retry',
      },
      `Retry attempt ${attempt} for ${domain}`
    );
  });

  domainRetryPolicies.set(domain, retryPolicy);
  return retryPolicy;
}

/**
 * Executes a function with retry and circuit breaker protection.
 * Use this for all scrape operations to ensure resilience.
 *
 * @param domain - The domain being scraped (for per-domain circuit)
 * @param fn - The async function to execute
 * @returns The result of the function
 * @throws When all retries are exhausted or circuit is open
 */
export async function executeWithResilience<T>(
  domain: string,
  fn: () => Promise<T>
): Promise<T> {
  const circuit = getCircuitBreaker(domain);
  const retryPolicy = getRetryPolicy(domain);

  // Combine retry and circuit breaker: retry wraps circuit breaker
  const combined = wrap(retryPolicy, circuit);

  return combined.execute(fn);
}

/**
 * Checks if the circuit breaker for a domain is currently open.
 * Use this to skip scraping domains that are experiencing issues.
 *
 * @param domain - The domain to check
 * @returns True if the circuit is open (blocking requests)
 */
export function isCircuitOpen(domain: string): boolean {
  const circuit = domainCircuits.get(domain);
  if (!circuit) return false;

  return circuit.state === CircuitState.Open;
}

/**
 * Returns the current state of all circuit breakers.
 * Useful for admin dashboards and monitoring.
 */
export function getCircuitBreakerStates(): Record<string, string> {
  const states: Record<string, string> = {};

  for (const [domain, circuit] of domainCircuits) {
    const state = circuit.state;
    states[domain] = state === CircuitState.Closed ? 'closed' : state === CircuitState.HalfOpen ? 'half-open' : 'open';
  }

  return states;
}

/**
 * Manually resets a circuit breaker for a domain.
 * Use this after fixing an issue to allow immediate retries.
 *
 * @param domain - The domain to reset the circuit for
 */
export function resetCircuitBreaker(domain: string): void {
  const circuit = domainCircuits.get(domain);
  if (circuit && circuit.state !== CircuitState.Closed) {
    // Remove and recreate to reset
    domainCircuits.delete(domain);
    domainRetryPolicies.delete(domain);
    logger.info({ domain, action: 'circuit_manual_reset' }, `Circuit breaker manually reset for ${domain}`);
  }
}

/**
 * List of error types that should trigger retries.
 * Network-related and 5xx errors are retryable.
 * 4xx client errors should not be retried.
 */
export const RETRYABLE_ERROR_CODES = [
  'ETIMEDOUT',
  'ECONNRESET',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ENETUNREACH',
  'EHOSTUNREACH',
];

/**
 * Checks if an error is retryable based on error codes and status codes.
 *
 * @param error - The error to check
 * @returns True if the error is transient and worth retrying
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    // Check for network error codes
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode && RETRYABLE_ERROR_CODES.includes(errorCode)) {
      return true;
    }

    // Check for HTTP 5xx errors
    const statusCode = (error as { response?: { status?: number } }).response?.status;
    if (statusCode && statusCode >= 500) {
      return true;
    }

    // Check error message for common transient issues
    const message = error.message.toLowerCase();
    if (message.includes('timeout') || message.includes('socket hang up')) {
      return true;
    }
  }

  return false;
}
