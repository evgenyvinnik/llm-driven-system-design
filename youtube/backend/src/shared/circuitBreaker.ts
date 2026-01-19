import CircuitBreaker from 'opossum';
import logger, { logEvent } from './logger.js';
import { circuitBreakerState, circuitBreakerFailuresTotal } from './metrics.js';

/**
 * Circuit Breaker Module
 *
 * Circuit breakers prevent cascade failures by:
 * 1. Detecting when a service is failing repeatedly
 * 2. "Opening" the circuit to fail fast instead of waiting
 * 3. Periodically testing if the service has recovered
 * 4. "Closing" the circuit when the service is healthy again
 *
 * States:
 * - CLOSED (0): Normal operation, requests pass through
 * - OPEN (1): Service is down, requests fail immediately
 * - HALF_OPEN (2): Testing if service has recovered
 */

// Circuit breaker state constants
const STATE = {
  CLOSED: 0,
  OPEN: 1,
  HALF_OPEN: 2,
} as const;

// Default circuit breaker options
const DEFAULT_OPTIONS: CircuitBreaker.Options = {
  timeout: 10000, // 10s - time to wait for response
  errorThresholdPercentage: 50, // Open circuit if 50% of requests fail
  resetTimeout: 30000, // 30s - time before trying again
  volumeThreshold: 5, // Minimum requests before tripping
};

// Store all circuit breakers for health checks
const circuitBreakers = new Map<string, CircuitBreaker>();

export interface CircuitBreakerHealth {
  state: 'open' | 'half-open' | 'closed';
  stats: {
    successes: number;
    failures: number;
    timeouts: number;
    rejects: number;
    fallbacks: number;
  };
}

/**
 * Create a circuit breaker for a service
 *
 * @param name - Service name (e.g., 'storage', 'transcoding')
 * @param fn - Async function to wrap
 * @param options - Circuit breaker options
 * @returns Configured circuit breaker
 */
export function createCircuitBreaker<T extends (...args: unknown[]) => Promise<unknown>>(
  name: string,
  fn: T,
  options: Partial<CircuitBreaker.Options> = {}
): CircuitBreaker<Parameters<T>, Awaited<ReturnType<T>>> {
  const breaker = new CircuitBreaker(fn, {
    ...DEFAULT_OPTIONS,
    ...options,
    name,
  });

  // Event handlers for monitoring
  breaker.on('success', (result: unknown, latencyMs: number) => {
    logger.debug(
      {
        event: 'circuit_breaker_success',
        service: name,
        latencyMs,
      },
      `Circuit breaker ${name}: success`
    );
  });

  breaker.on('timeout', () => {
    logger.warn(
      {
        event: 'circuit_breaker_timeout',
        service: name,
      },
      `Circuit breaker ${name}: timeout`
    );
    circuitBreakerFailuresTotal.inc({ service: name });
  });

  breaker.on('reject', () => {
    logger.warn(
      {
        event: 'circuit_breaker_reject',
        service: name,
      },
      `Circuit breaker ${name}: rejected (circuit open)`
    );
  });

  breaker.on('open', () => {
    logEvent.circuitBreakerOpen(logger, {
      service: name,
      failures: breaker.stats.failures,
    });
    circuitBreakerState.set({ service: name }, STATE.OPEN);
  });

  breaker.on('halfOpen', () => {
    logger.info(
      {
        event: 'circuit_breaker_half_open',
        service: name,
      },
      `Circuit breaker ${name}: half-open (testing)`
    );
    circuitBreakerState.set({ service: name }, STATE.HALF_OPEN);
  });

  breaker.on('close', () => {
    logEvent.circuitBreakerClose(logger, { service: name });
    circuitBreakerState.set({ service: name }, STATE.CLOSED);
  });

  breaker.on('failure', (error: Error) => {
    logger.warn(
      {
        event: 'circuit_breaker_failure',
        service: name,
        error: error.message,
      },
      `Circuit breaker ${name}: failure`
    );
    circuitBreakerFailuresTotal.inc({ service: name });
  });

  breaker.on('fallback', (result: unknown) => {
    logger.info(
      {
        event: 'circuit_breaker_fallback',
        service: name,
      },
      `Circuit breaker ${name}: using fallback`
    );
  });

  // Initialize metrics
  circuitBreakerState.set({ service: name }, STATE.CLOSED);

  // Store for health checks
  circuitBreakers.set(name, breaker);

  return breaker;
}

export interface CircuitOpenError extends Error {
  code: 'CIRCUIT_OPEN';
  service: string;
}

/**
 * Create circuit-protected wrapper function
 *
 * @param name - Service name
 * @param fn - Function to wrap
 * @param fallback - Optional fallback function
 * @param options - Circuit breaker options
 * @returns Wrapped function
 */
export function withCircuitBreaker<T extends (...args: unknown[]) => Promise<unknown>>(
  name: string,
  fn: T,
  fallback: ((...args: Parameters<T>) => ReturnType<T>) | null = null,
  options: Partial<CircuitBreaker.Options> = {}
): (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>> {
  const breaker = createCircuitBreaker(name, fn, options);

  if (fallback) {
    breaker.fallback(fallback as (...args: unknown[]) => unknown);
  }

  return async (...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> => {
    try {
      return (await breaker.fire(...args)) as Awaited<ReturnType<T>>;
    } catch (error) {
      // Re-throw if no fallback and circuit is open
      if (breaker.opened) {
        const circuitError = new Error(`Service ${name} is unavailable (circuit open)`) as CircuitOpenError;
        circuitError.code = 'CIRCUIT_OPEN';
        circuitError.service = name;
        throw circuitError;
      }
      throw error;
    }
  };
}

/**
 * Get health status of all circuit breakers
 * @returns Health status
 */
export function getCircuitBreakerHealth(): Record<string, CircuitBreakerHealth> {
  const health: Record<string, CircuitBreakerHealth> = {};

  for (const [name, breaker] of circuitBreakers) {
    health[name] = {
      state: breaker.opened ? 'open' : breaker.halfOpen ? 'half-open' : 'closed',
      stats: {
        successes: breaker.stats.successes,
        failures: breaker.stats.failures,
        timeouts: breaker.stats.timeouts,
        rejects: breaker.stats.rejects,
        fallbacks: breaker.stats.fallbacks,
      },
    };
  }

  return health;
}

/**
 * Check if any circuit breaker is open
 * @returns True if any circuit is open
 */
export function hasOpenCircuit(): boolean {
  for (const [, breaker] of circuitBreakers) {
    if (breaker.opened) {
      return true;
    }
  }
  return false;
}

/**
 * Get a specific circuit breaker
 * @param name - Circuit breaker name
 * @returns CircuitBreaker or undefined
 */
export function getCircuitBreaker(name: string): CircuitBreaker | undefined {
  return circuitBreakers.get(name);
}

export default {
  createCircuitBreaker,
  withCircuitBreaker,
  getCircuitBreakerHealth,
  hasOpenCircuit,
  getCircuitBreaker,
};
