import CircuitBreaker from 'opossum';
import logger from './logger.js';
import {
  circuitBreakerState,
  circuitBreakerFailures,
  circuitBreakerSuccesses,
} from './metrics.js';

/**
 * Circuit Breaker Module using Opossum
 *
 * WHY: Circuit breakers prevent cascading failures by:
 * - Failing fast when downstream services are unhealthy
 * - Reducing load on failing services to allow recovery
 * - Providing fallback responses for graceful degradation
 * - Automatically attempting recovery after cooldown period
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Service unhealthy, requests fail immediately
 * - HALF-OPEN: Testing if service recovered
 */

interface CircuitBreakerOptions {
  timeout?: number;
  errorThresholdPercentage?: number;
  resetTimeout?: number;
  volumeThreshold?: number;
  name?: string;
}

interface CircuitBreakerStats {
  successes: number;
  failures: number;
  timeouts: number;
  rejects: number;
  fallbacks: number;
}

interface CircuitBreakerHealth {
  state: string;
  stats: CircuitBreakerStats;
}

// Default circuit breaker options
const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  timeout: 5000, // 5 seconds timeout for wrapped function
  errorThresholdPercentage: 50, // Open if 50% of requests fail
  resetTimeout: 30000, // 30 seconds before trying again
  volumeThreshold: 5, // Minimum requests before considering opening
};

// Store all circuit breakers for health reporting
const circuitBreakers = new Map<string, CircuitBreaker>();

/**
 * Create a circuit breaker for a function
 */
function createCircuitBreaker<T extends unknown[], R>(
  name: string,
  fn: (...args: T) => Promise<R>,
  options: CircuitBreakerOptions = {},
  fallback: ((...args: T) => Promise<R>) | null = null
): CircuitBreaker<T, R> {
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options, name };

  const breaker = new CircuitBreaker<T, R>(fn, mergedOptions);

  // Set up event listeners for logging and metrics
  breaker.on('success', () => {
    circuitBreakerSuccesses.inc({ name });
    circuitBreakerState.set({ name }, 0); // CLOSED = 0
  });

  breaker.on('failure', (error: Error) => {
    circuitBreakerFailures.inc({ name });
    logger.warn({ circuit: name, error: error.message }, 'Circuit breaker recorded failure');
  });

  breaker.on('open', () => {
    circuitBreakerState.set({ name }, 1); // OPEN = 1
    logger.error({ circuit: name }, 'Circuit breaker OPENED - failing fast');
  });

  breaker.on('halfOpen', () => {
    circuitBreakerState.set({ name }, 0.5); // HALF-OPEN = 0.5
    logger.info({ circuit: name }, 'Circuit breaker HALF-OPEN - testing recovery');
  });

  breaker.on('close', () => {
    circuitBreakerState.set({ name }, 0); // CLOSED = 0
    logger.info({ circuit: name }, 'Circuit breaker CLOSED - service recovered');
  });

  breaker.on('timeout', () => {
    logger.warn({ circuit: name }, 'Circuit breaker timeout');
  });

  breaker.on('reject', () => {
    logger.warn({ circuit: name }, 'Circuit breaker rejected request (circuit open)');
  });

  // Optional fallback
  if (fallback) {
    breaker.fallback(fallback);
  }

  // Store for health reporting
  circuitBreakers.set(name, breaker as CircuitBreaker);

  // Initialize metric
  circuitBreakerState.set({ name }, 0);

  return breaker;
}

/**
 * Get health status of all circuit breakers
 */
function getCircuitBreakerHealth(): Record<string, CircuitBreakerHealth> {
  const health: Record<string, CircuitBreakerHealth> = {};
  for (const [name, breaker] of circuitBreakers) {
    const stats = breaker.stats;
    health[name] = {
      state: breaker.opened ? 'OPEN' : breaker.halfOpen ? 'HALF-OPEN' : 'CLOSED',
      stats: {
        successes: stats.successes,
        failures: stats.failures,
        timeouts: stats.timeouts,
        rejects: stats.rejects,
        fallbacks: stats.fallbacks,
      },
    };
  }
  return health;
}

/**
 * Preconfigured circuit breakers for common operations
 */

// Routing service circuit breaker for graph loading
const routingCircuitBreakerOptions: CircuitBreakerOptions = {
  timeout: 10000, // 10 seconds for complex routes
  errorThresholdPercentage: 60,
  resetTimeout: 60000, // 1 minute cooldown
  volumeThreshold: 3,
};

// Geocoding service circuit breaker
const geocodingCircuitBreakerOptions: CircuitBreakerOptions = {
  timeout: 5000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
  volumeThreshold: 5,
};

// External traffic provider circuit breaker (if using external APIs)
const externalTrafficCircuitBreakerOptions: CircuitBreakerOptions = {
  timeout: 3000, // Fast timeout for external calls
  errorThresholdPercentage: 40,
  resetTimeout: 60000,
  volumeThreshold: 10,
};

// Database circuit breaker options
const databaseCircuitBreakerOptions: CircuitBreakerOptions = {
  timeout: 5000,
  errorThresholdPercentage: 30, // Lower threshold for DB
  resetTimeout: 15000, // Faster recovery attempt
  volumeThreshold: 5,
};

export {
  createCircuitBreaker,
  getCircuitBreakerHealth,
  routingCircuitBreakerOptions,
  geocodingCircuitBreakerOptions,
  externalTrafficCircuitBreakerOptions,
  databaseCircuitBreakerOptions,
  circuitBreakers,
};
export type { CircuitBreakerOptions, CircuitBreakerHealth };
