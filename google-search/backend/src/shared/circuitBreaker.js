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

// Default circuit breaker options
const defaultOptions = {
  timeout: 10000, // 10 seconds - if operation takes longer, trip
  errorThresholdPercentage: 50, // Trip if 50% of requests fail
  resetTimeout: 30000, // After 30s, try again (half-open)
  volumeThreshold: 5, // Minimum requests before tripping
};

// Store circuit breakers by name
const circuitBreakers = new Map();

/**
 * Create or get a circuit breaker for a service
 */
export const createCircuitBreaker = (name, asyncFn, options = {}) => {
  if (circuitBreakers.has(name)) {
    return circuitBreakers.get(name);
  }

  const breaker = new CircuitBreaker(asyncFn, {
    ...defaultOptions,
    ...options,
    name,
  });

  // Map state to numeric value for metrics
  const stateToNumber = (state) => {
    switch (state) {
      case 'closed':
        return 0;
      case 'halfOpen':
        return 1;
      case 'open':
        return 2;
      default:
        return -1;
    }
  };

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

  breaker.on('fallback', (result) => {
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
export const getCircuitBreakerStatus = () => {
  const status = {};
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
  wrap: (operation) => {
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
  execute: async (operation, fallback = null) => {
    const breaker = circuitBreakers.get('elasticsearch');

    if (!breaker) {
      // First call - create the breaker
      const newBreaker = createCircuitBreaker(
        'elasticsearch',
        async (fn) => fn(),
        {
          timeout: 15000,
          errorThresholdPercentage: 40,
          resetTimeout: 20000,
        }
      );

      if (fallback) {
        newBreaker.fallback(() => fallback);
      }

      return newBreaker.fire(operation);
    }

    if (fallback) {
      breaker.fallback(() => fallback);
    }

    return breaker.fire(operation);
  },
};

/**
 * Pre-configured circuit breaker for Redis operations
 */
export const redisBreaker = {
  execute: async (operation, fallback = null) => {
    let breaker = circuitBreakers.get('redis');

    if (!breaker) {
      breaker = createCircuitBreaker(
        'redis',
        async (fn) => fn(),
        {
          timeout: 5000, // Redis should be fast
          errorThresholdPercentage: 50,
          resetTimeout: 10000,
        }
      );
    }

    if (fallback) {
      breaker.fallback(() => fallback);
    }

    return breaker.fire(operation);
  },
};

/**
 * Pre-configured circuit breaker for PostgreSQL operations
 */
export const postgresBreaker = {
  execute: async (operation, fallback = null) => {
    let breaker = circuitBreakers.get('postgres');

    if (!breaker) {
      breaker = createCircuitBreaker(
        'postgres',
        async (fn) => fn(),
        {
          timeout: 10000,
          errorThresholdPercentage: 50,
          resetTimeout: 30000,
        }
      );
    }

    if (fallback) {
      breaker.fallback(() => fallback);
    }

    return breaker.fire(operation);
  },
};

export { circuitBreakers };
