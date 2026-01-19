/**
 * Circuit Breaker Implementation using Opossum
 *
 * Protects services from cascading failures by:
 * - Tracking failure rates for external calls
 * - Opening the circuit when failures exceed threshold
 * - Allowing gradual recovery via half-open state
 *
 * Use cases:
 * - Stream ingest service calls
 * - Chat message publishing to Redis
 * - Database queries during high load
 */
import CircuitBreaker from 'opossum';
import { logger } from './logger.js';
import { setCircuitBreakerState, incCircuitBreakerFailure } from './metrics.js';

interface CircuitBreakerOptions {
  timeout?: number;
  errorThresholdPercentage?: number;
  resetTimeout?: number;
  volumeThreshold?: number;
  rollingCountTimeout?: number;
  rollingCountBuckets?: number;
}

// Default options for circuit breakers
const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  timeout: 3000,              // Max time to wait for action to complete
  errorThresholdPercentage: 50, // Error percentage at which to open circuit
  resetTimeout: 10000,        // Time to wait before entering half-open state
  volumeThreshold: 5,         // Minimum requests before calculating error rate
  rollingCountTimeout: 10000, // Time window for counting requests
  rollingCountBuckets: 10     // Number of buckets in the rolling window
};

// Store all created circuit breakers for monitoring
const circuitBreakers = new Map<string, CircuitBreaker>();

interface CircuitBreakerStats {
  state: string;
  stats: unknown;
}

/**
 * Create a circuit breaker for an async function
 */
function createCircuitBreaker<TArgs extends unknown[], TResult>(
  name: string,
  fn: (...args: TArgs) => Promise<TResult>,
  options: CircuitBreakerOptions = {}
): CircuitBreaker<TArgs, TResult> {
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };
  const breaker = new CircuitBreaker(fn, mergedOptions);

  // Log and update metrics on state changes
  breaker.on('open', () => {
    logger.error({ circuit: name }, 'Circuit breaker OPENED - calls will fail fast');
    setCircuitBreakerState(name, 'open');
  });

  breaker.on('halfOpen', () => {
    logger.warn({ circuit: name }, 'Circuit breaker HALF-OPEN - testing with next request');
    setCircuitBreakerState(name, 'halfOpen');
  });

  breaker.on('close', () => {
    logger.info({ circuit: name }, 'Circuit breaker CLOSED - normal operation resumed');
    setCircuitBreakerState(name, 'closed');
  });

  breaker.on('failure', (error: Error) => {
    logger.warn({ circuit: name, error: error.message }, 'Circuit breaker recorded failure');
    incCircuitBreakerFailure(name);
  });

  breaker.on('timeout', () => {
    logger.warn({ circuit: name }, 'Circuit breaker request timed out');
  });

  breaker.on('reject', () => {
    logger.warn({ circuit: name }, 'Circuit breaker rejected request (circuit open)');
  });

  breaker.on('fallback', () => {
    logger.info({ circuit: name }, 'Circuit breaker fallback executed');
  });

  // Store for monitoring
  circuitBreakers.set(name, breaker);

  // Initialize metrics
  setCircuitBreakerState(name, 'closed');

  return breaker;
}

/**
 * Get statistics for all circuit breakers
 */
function getCircuitBreakerStats(): Record<string, CircuitBreakerStats> {
  const stats: Record<string, CircuitBreakerStats> = {};
  circuitBreakers.forEach((breaker, name) => {
    stats[name] = {
      state: breaker.opened ? 'open' : (breaker.halfOpen ? 'halfOpen' : 'closed'),
      stats: breaker.stats
    };
  });
  return stats;
}

/**
 * Get a specific circuit breaker by name
 */
function getCircuitBreaker(name: string): CircuitBreaker | undefined {
  return circuitBreakers.get(name);
}

// ===================
// Pre-configured Circuit Breakers
// ===================

/**
 * Circuit breaker for Redis pub/sub operations
 * - Shorter timeout since Redis should be fast
 * - Higher volume threshold for chat traffic
 */
function createRedisChatBreaker<TArgs extends unknown[], TResult>(
  redisPublishFn: (...args: TArgs) => Promise<TResult>
): CircuitBreaker<TArgs, TResult> {
  return createCircuitBreaker('redis-chat', redisPublishFn, {
    timeout: 1000,
    volumeThreshold: 10,
    resetTimeout: 5000
  });
}

/**
 * Circuit breaker for stream ingest operations
 * - Longer timeout for video operations
 * - Lower error threshold (streams are critical)
 */
function createStreamIngestBreaker<TArgs extends unknown[], TResult>(
  ingestFn: (...args: TArgs) => Promise<TResult>
): CircuitBreaker<TArgs, TResult> {
  return createCircuitBreaker('stream-ingest', ingestFn, {
    timeout: 5000,
    errorThresholdPercentage: 30,
    resetTimeout: 15000
  });
}

/**
 * Circuit breaker for database operations
 * - Medium timeout
 * - Standard thresholds
 */
function createDatabaseBreaker<TArgs extends unknown[], TResult>(
  dbFn: (...args: TArgs) => Promise<TResult>
): CircuitBreaker<TArgs, TResult> {
  return createCircuitBreaker('database', dbFn, {
    timeout: 3000,
    volumeThreshold: 5,
    resetTimeout: 10000
  });
}

/**
 * Wrap an async function with circuit breaker protection
 * Falls back to a provided fallback function or throws
 */
function withCircuitBreaker<TArgs extends unknown[], TResult>(
  name: string,
  fn: (...args: TArgs) => Promise<TResult>,
  options: CircuitBreakerOptions = {},
  fallback: ((...args: TArgs) => TResult) | null = null
): (...args: TArgs) => Promise<TResult> {
  const breaker = createCircuitBreaker(name, fn, options);

  if (fallback) {
    breaker.fallback(fallback);
  }

  return async (...args: TArgs): Promise<TResult> => {
    return breaker.fire(...args);
  };
}

export {
  createCircuitBreaker,
  getCircuitBreakerStats,
  getCircuitBreaker,
  createRedisChatBreaker,
  createStreamIngestBreaker,
  createDatabaseBreaker,
  withCircuitBreaker,
  DEFAULT_OPTIONS
};
