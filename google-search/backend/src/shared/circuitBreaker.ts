import CircuitBreaker from 'opossum';
import { logger } from './logger.js';
import {
  circuitBreakerStateGauge,
  circuitBreakerTripsCounter,
} from './metrics.js';

/**
 * Circuit Breaker Module
 *
 * WHY circuit breakers protect index availability:
 * - Prevent cascade failures when Elasticsearch is slow/down
 * - Allow the system to fail fast instead of queueing requests
 * - Give failing services time to recover
 * - Enable graceful degradation with fallback responses
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Requests fail immediately, no load on backend
 * - HALF_OPEN: Testing if backend has recovered
 */

export interface CircuitBreakerOptions {
  timeout?: number;
  errorThresholdPercentage?: number;
  resetTimeout?: number;
  volumeThreshold?: number;
  name?: string;
}

export interface CircuitBreakerStats {
  successes: number;
  failures: number;
  rejects: number;
  timeouts: number;
  fallbacks: number;
}

export interface CircuitBreakerStatus {
  state: 'CLOSED' | 'HALF_OPEN' | 'OPEN';
  stats: CircuitBreakerStats;
}

// Default circuit breaker options
const defaultOptions: CircuitBreakerOptions = {
  timeout: 10000, // 10 seconds - if operation takes longer, trip
  errorThresholdPercentage: 50, // Trip if 50% of requests fail
  resetTimeout: 30000, // After 30s, try again (half-open)
  volumeThreshold: 5, // Minimum requests before tripping
};

// Store circuit breakers by name
const circuitBreakers = new Map<string, CircuitBreaker>();

/**
 * Create or get a circuit breaker for a service
 */
export const createCircuitBreaker = <T>(
  name: string,
  asyncFn: (...args: unknown[]) => Promise<T>,
  options: CircuitBreakerOptions = {}
): CircuitBreaker => {
  if (circuitBreakers.has(name)) {
    return circuitBreakers.get(name)!;
  }

  const breaker = new CircuitBreaker(asyncFn, {
    ...defaultOptions,
    ...options,
    name,
  });

  // Track state changes
  breaker.on('open', () => {
    logger.warn({ service: name, event: 'circuit_breaker_open' }, `Circuit breaker ${name} opened`);
    circuitBreakerStateGauge.labels(name).set(2);
    circuitBreakerTripsCounter.labels(name).inc();
  });

  breaker.on('halfOpen', () => {
    logger.info({ service: name, event: 'circuit_breaker_half_open' }, `Circuit breaker ${name} half-open`);
    circuitBreakerStateGauge.labels(name).set(1);
  });

  breaker.on('close', () => {
    logger.info({ service: name, event: 'circuit_breaker_closed' }, `Circuit breaker ${name} closed`);
    circuitBreakerStateGauge.labels(name).set(0);
  });

  breaker.on('timeout', () => {
    logger.warn({ service: name, event: 'circuit_breaker_timeout' }, `Circuit breaker ${name} timeout`);
  });

  breaker.on('reject', () => {
    logger.warn({ service: name, event: 'circuit_breaker_reject' }, `Circuit breaker ${name} rejected request`);
  });

  breaker.on('fallback', () => {
    logger.info({ service: name, event: 'circuit_breaker_fallback' }, `Circuit breaker ${name} returned fallback`);
  });

  // Initialize state gauge
  circuitBreakerStateGauge.labels(name).set(0);

  circuitBreakers.set(name, breaker);
  return breaker;
};

/**
 * Get status of all circuit breakers
 */
export const getCircuitBreakerStatus = (): Record<string, CircuitBreakerStatus> => {
  const status: Record<string, CircuitBreakerStatus> = {};
  for (const [name, breaker] of circuitBreakers) {
    const stats = breaker.stats;
    status[name] = {
      state: breaker.opened ? 'OPEN' : breaker.halfOpen ? 'HALF_OPEN' : 'CLOSED',
      stats: {
        successes: stats.successes,
        failures: stats.failures,
        rejects: stats.rejects,
        timeouts: stats.timeouts,
        fallbacks: stats.fallbacks,
      },
    };
  }
  return status;
};

/**
 * Pre-configured circuit breaker for Elasticsearch operations
 */
export const elasticsearchBreaker = {
  /**
   * Wrap an Elasticsearch operation with circuit breaker protection
   */
  wrap: <T>(operation: () => Promise<T>): CircuitBreaker => {
    const breaker = createCircuitBreaker(
      'elasticsearch',
      operation,
      {
        timeout: 15000, // ES operations can be slow
        errorThresholdPercentage: 40,
        resetTimeout: 20000,
      }
    );
    return breaker;
  },

  /**
   * Execute an operation with circuit breaker and fallback
   */
  execute: async <T>(operation: () => Promise<T>, fallback: T | null = null): Promise<T> => {
    let breaker = circuitBreakers.get('elasticsearch');

    if (!breaker) {
      // First call - create the breaker
      breaker = createCircuitBreaker(
        'elasticsearch',
        async (fn: () => Promise<T>) => fn(),
        {
          timeout: 15000,
          errorThresholdPercentage: 40,
          resetTimeout: 20000,
        }
      );
    }

    if (fallback !== null) {
      breaker.fallback(() => fallback);
    }

    return breaker.fire(operation) as Promise<T>;
  },
};

/**
 * Pre-configured circuit breaker for Redis operations
 */
export const redisBreaker = {
  execute: async <T>(operation: () => Promise<T>, fallback: T | null = null): Promise<T> => {
    let breaker = circuitBreakers.get('redis');

    if (!breaker) {
      breaker = createCircuitBreaker(
        'redis',
        async (fn: () => Promise<T>) => fn(),
        {
          timeout: 5000, // Redis should be fast
          errorThresholdPercentage: 50,
          resetTimeout: 10000,
        }
      );
    }

    if (fallback !== null) {
      breaker.fallback(() => fallback);
    }

    return breaker.fire(operation) as Promise<T>;
  },
};

/**
 * Pre-configured circuit breaker for PostgreSQL operations
 */
export const postgresBreaker = {
  execute: async <T>(operation: () => Promise<T>, fallback: T | null = null): Promise<T> => {
    let breaker = circuitBreakers.get('postgres');

    if (!breaker) {
      breaker = createCircuitBreaker(
        'postgres',
        async (fn: () => Promise<T>) => fn(),
        {
          timeout: 10000,
          errorThresholdPercentage: 50,
          resetTimeout: 30000,
        }
      );
    }

    if (fallback !== null) {
      breaker.fallback(() => fallback);
    }

    return breaker.fire(operation) as Promise<T>;
  },
};

export { circuitBreakers };
