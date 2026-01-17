/**
 * Circuit breaker module for protecting the messaging pipeline.
 *
 * Implements the circuit breaker pattern to prevent cascade failures
 * when downstream services (Redis, PostgreSQL) become unhealthy.
 *
 * WHY circuit breakers protect the messaging pipeline:
 * - Prevents resource exhaustion when a dependency is failing
 * - Fails fast instead of hanging on timeouts, improving UX
 * - Allows the failing service time to recover
 * - Provides fallback behavior during outages
 * - Enables partial system functionality during degraded state
 *
 * Circuit states:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Failing, requests immediately rejected for failsafe
 * - HALF-OPEN: Testing if service recovered, limited requests allowed
 *
 * Configuration is tuned for messaging workloads:
 * - Short timeout (3s) because messages should be fast
 * - Moderate error threshold (50%) to catch genuine failures
 * - 30s reset timeout to give services time to recover
 */

import CircuitBreaker from 'opossum';
import { circuitBreakerState } from './metrics.js';
import { logger, LogEvents } from './logger.js';

/**
 * Default options for circuit breakers in this application.
 * Tuned for low-latency messaging workloads.
 */
const defaultOptions: CircuitBreaker.Options = {
  // Request timeout - if operation takes longer, count as failure
  timeout: 3000, // 3 seconds

  // Error threshold percentage to trip the circuit
  errorThresholdPercentage: 50,

  // Time window to measure error percentage
  rollingCountTimeout: 10000, // 10 seconds

  // Number of buckets in the rolling window
  rollingCountBuckets: 10,

  // Minimum requests before calculating error percentage
  volumeThreshold: 5,

  // Time to wait before attempting to close circuit
  resetTimeout: 30000, // 30 seconds

  // Enable request caching (disabled for messaging)
  cache: false,
};

/**
 * Creates a circuit breaker for a given async operation.
 *
 * @param name - Identifier for this circuit (used in logs and metrics)
 * @param fn - The async function to wrap
 * @param options - Custom circuit breaker options
 * @returns A circuit breaker wrapping the function
 */
export function createCircuitBreaker<T extends (...args: any[]) => Promise<any>>(
  name: string,
  fn: T,
  options: Partial<CircuitBreaker.Options> = {}
): CircuitBreaker {
  const breaker = new CircuitBreaker(fn, {
    ...defaultOptions,
    ...options,
    name,
  });

  // Update metrics on state changes
  breaker.on('open', () => {
    circuitBreakerState.set({ name }, 1);
    logger.error({
      event: LogEvents.CIRCUIT_OPEN,
      circuit: name,
      message: `Circuit breaker ${name} is OPEN - requests will fail fast`,
    });
  });

  breaker.on('halfOpen', () => {
    circuitBreakerState.set({ name }, 0.5);
    logger.info({
      circuit: name,
      message: `Circuit breaker ${name} is HALF-OPEN - testing recovery`,
    });
  });

  breaker.on('close', () => {
    circuitBreakerState.set({ name }, 0);
    logger.info({
      event: LogEvents.CIRCUIT_CLOSE,
      circuit: name,
      message: `Circuit breaker ${name} is CLOSED - normal operation resumed`,
    });
  });

  breaker.on('timeout', () => {
    logger.warn({
      circuit: name,
      message: `Circuit breaker ${name} timeout`,
    });
  });

  breaker.on('reject', () => {
    logger.warn({
      circuit: name,
      message: `Circuit breaker ${name} rejected request (circuit open)`,
    });
  });

  // Initialize metric to closed state
  circuitBreakerState.set({ name }, 0);

  return breaker;
}

/**
 * Wraps Redis pub/sub operations with a circuit breaker.
 * Falls back to local-only delivery when Redis is unavailable.
 */
export function createRedisCircuitBreaker() {
  return createCircuitBreaker(
    'redis_pubsub',
    async (operation: () => Promise<any>) => {
      return operation();
    },
    {
      timeout: 2000, // 2 second timeout for Redis
      errorThresholdPercentage: 60,
      resetTimeout: 15000, // 15 seconds - Redis usually recovers fast
    }
  );
}

/**
 * Wraps database operations with a circuit breaker.
 * Provides graceful degradation when the database is overwhelmed.
 */
export function createDatabaseCircuitBreaker() {
  return createCircuitBreaker(
    'database',
    async (operation: () => Promise<any>) => {
      return operation();
    },
    {
      timeout: 5000, // 5 second timeout for DB
      errorThresholdPercentage: 50,
      resetTimeout: 30000, // 30 seconds for DB recovery
    }
  );
}

// Pre-configured circuit breakers for common operations
export const redisCircuit = createRedisCircuitBreaker();
export const dbCircuit = createDatabaseCircuitBreaker();

/**
 * Executes a Redis operation with circuit breaker protection.
 *
 * @param operation - The Redis operation to execute
 * @param fallback - Optional fallback value if circuit is open
 * @returns The operation result or fallback value
 */
export async function withRedisCircuit<T>(
  operation: () => Promise<T>,
  fallback?: T
): Promise<T> {
  try {
    return await redisCircuit.fire(operation) as T;
  } catch (error) {
    if (fallback !== undefined) {
      logger.warn({
        circuit: 'redis_pubsub',
        message: 'Using fallback due to circuit breaker',
      });
      return fallback;
    }
    throw error;
  }
}

/**
 * Executes a database operation with circuit breaker protection.
 *
 * @param operation - The database operation to execute
 * @param fallback - Optional fallback value if circuit is open
 * @returns The operation result or fallback value
 */
export async function withDbCircuit<T>(
  operation: () => Promise<T>,
  fallback?: T
): Promise<T> {
  try {
    return await dbCircuit.fire(operation) as T;
  } catch (error) {
    if (fallback !== undefined) {
      logger.warn({
        circuit: 'database',
        message: 'Using fallback due to circuit breaker',
      });
      return fallback;
    }
    throw error;
  }
}

/**
 * Gets the current status of all circuit breakers.
 * Used for health checks and monitoring.
 */
export function getCircuitBreakerStatus() {
  return {
    redis: {
      state: redisCircuit.opened ? 'open' : redisCircuit.halfOpen ? 'half-open' : 'closed',
      stats: redisCircuit.stats,
    },
    database: {
      state: dbCircuit.opened ? 'open' : dbCircuit.halfOpen ? 'half-open' : 'closed',
      stats: dbCircuit.stats,
    },
  };
}
