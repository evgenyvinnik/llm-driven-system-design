/**
 * @fileoverview Circuit breaker implementation for database operations.
 *
 * Provides circuit breaker protection for time-series database queries using
 * the Opossum library. The circuit breaker prevents cascade failures when
 * the database is slow or unresponsive.
 *
 * WHY circuit breakers protect against slow queries:
 * Without a circuit breaker, slow database queries accumulate, exhausting
 * connection pools and causing cascading failures. The circuit breaker
 * "trips" after detecting repeated failures, immediately rejecting new
 * requests and allowing the database to recover. This prevents:
 * - Connection pool exhaustion from hung queries
 * - Thread/worker starvation waiting on slow responses
 * - Cascading failures to downstream services
 * - Poor user experience from long timeouts
 *
 * The breaker automatically tests recovery with periodic "half-open" probes,
 * restoring normal operation once the database is healthy.
 */

import CircuitBreaker from 'opossum';
import { QueryResult, QueryResultRow } from 'pg';
import pool from '../db/pool.js';
import logger from './logger.js';
import { circuitBreakerState, circuitBreakerEvents } from './metrics.js';

/**
 * Creates an empty QueryResult for use as fallback.
 */
export function emptyQueryResult<T extends QueryResultRow = QueryResultRow>(): QueryResult<T> {
  return {
    rows: [] as T[],
    command: '',
    rowCount: 0,
    oid: 0,
    fields: [],
  };
}

/**
 * Configuration options for the database circuit breaker.
 */
interface CircuitBreakerConfig {
  /** Maximum time in ms to wait for a query before timing out */
  timeout: number;
  /** Percentage of failures to trigger circuit open (0-100) */
  errorThresholdPercentage: number;
  /** Time in ms the circuit stays open before testing recovery */
  resetTimeout: number;
  /** Minimum number of requests before calculating error percentage */
  volumeThreshold: number;
}

/**
 * Default circuit breaker configuration.
 * Tuned for time-series database queries.
 */
const DEFAULT_CONFIG: CircuitBreakerConfig = {
  timeout: 5000, // 5 second timeout for queries
  errorThresholdPercentage: 50, // Open after 50% failures
  resetTimeout: 30000, // Try again after 30 seconds
  volumeThreshold: 5, // Need at least 5 requests to calculate percentage
};

/**
 * Database query function signature.
 */
type DbQueryFunction = (query: string, params: unknown[]) => Promise<QueryResult>;

/**
 * Circuit breaker type for database operations.
 */
type DbCircuitBreaker = CircuitBreaker<[string, unknown[]], QueryResult>;

/**
 * Creates a circuit breaker wrapped around a database query function.
 *
 * @param name - Name for this circuit breaker (used in metrics and logs)
 * @param queryFn - The async function to protect with the circuit breaker
 * @param config - Optional configuration overrides
 * @returns Circuit breaker instance wrapping the query function
 */
export function createDbCircuitBreaker(
  name: string,
  queryFn: DbQueryFunction,
  config: Partial<CircuitBreakerConfig> = {}
): DbCircuitBreaker {
  const options = { ...DEFAULT_CONFIG, ...config };

  const breaker = new CircuitBreaker(queryFn, {
    timeout: options.timeout,
    errorThresholdPercentage: options.errorThresholdPercentage,
    resetTimeout: options.resetTimeout,
    volumeThreshold: options.volumeThreshold,
    name,
  });

  // Set up event handlers for monitoring and logging
  setupCircuitBreakerEvents(breaker, name);

  return breaker;
}

/**
 * Sets up event handlers for circuit breaker monitoring.
 *
 * @param breaker - The circuit breaker instance
 * @param name - Name for logging and metrics
 */
function setupCircuitBreakerEvents(breaker: DbCircuitBreaker, name: string): void {
  // Track circuit state in metrics
  breaker.on('open', () => {
    logger.warn({ breaker: name }, 'Circuit breaker opened - database protection active');
    circuitBreakerState.set({ name }, 1); // 1 = open
    circuitBreakerEvents.inc({ name, event: 'open' });
  });

  breaker.on('halfOpen', () => {
    logger.info({ breaker: name }, 'Circuit breaker half-open - testing recovery');
    circuitBreakerState.set({ name }, 0.5); // 0.5 = half-open
    circuitBreakerEvents.inc({ name, event: 'halfOpen' });
  });

  breaker.on('close', () => {
    logger.info({ breaker: name }, 'Circuit breaker closed - normal operation resumed');
    circuitBreakerState.set({ name }, 0); // 0 = closed
    circuitBreakerEvents.inc({ name, event: 'close' });
  });

  breaker.on('timeout', () => {
    logger.warn({ breaker: name }, 'Circuit breaker timeout - query took too long');
    circuitBreakerEvents.inc({ name, event: 'timeout' });
  });

  breaker.on('reject', () => {
    logger.debug({ breaker: name }, 'Circuit breaker rejected request - circuit is open');
    circuitBreakerEvents.inc({ name, event: 'reject' });
  });

  breaker.on('fallback', () => {
    logger.debug({ breaker: name }, 'Circuit breaker fallback executed');
    circuitBreakerEvents.inc({ name, event: 'fallback' });
  });

  breaker.on('success', () => {
    circuitBreakerEvents.inc({ name, event: 'success' });
  });

  breaker.on('failure', (error) => {
    logger.error({ breaker: name, error }, 'Circuit breaker recorded failure');
    circuitBreakerEvents.inc({ name, event: 'failure' });
  });
}

/**
 * Pre-configured circuit breaker for raw metric queries.
 * Used for time-series queries against the metrics table.
 */
export const metricsQueryBreaker = createDbCircuitBreaker(
  'metrics-query',
  (query: string, params: unknown[]) => pool.query(query, params),
  {
    timeout: 10000, // Allow 10s for complex time-series queries
    errorThresholdPercentage: 40,
    resetTimeout: 60000, // Wait 1 minute before retrying
    volumeThreshold: 3,
  }
);

/**
 * Pre-configured circuit breaker for metric ingestion.
 * More tolerant of failures since ingestion is often batched.
 */
export const metricsIngestBreaker = createDbCircuitBreaker(
  'metrics-ingest',
  (query: string, params: unknown[]) => pool.query(query, params),
  {
    timeout: 5000,
    errorThresholdPercentage: 60, // Higher tolerance for ingestion
    resetTimeout: 30000,
    volumeThreshold: 5,
  }
);

/**
 * Circuit breaker for dashboard/panel queries.
 * Less aggressive since these queries are typically fast.
 */
export const dashboardQueryBreaker = createDbCircuitBreaker(
  'dashboard-query',
  (query: string, params: unknown[]) => pool.query(query, params),
  {
    timeout: 3000,
    errorThresholdPercentage: 50,
    resetTimeout: 20000,
    volumeThreshold: 3,
  }
);

/**
 * Wraps a database query with circuit breaker protection.
 * Provides a fallback value if the circuit is open.
 *
 * @param breaker - The circuit breaker to use
 * @param query - SQL query string
 * @param params - Query parameters
 * @param fallback - Value to return if circuit is open
 * @returns Query result or fallback value
 *
 * @example
 * const result = await withCircuitBreaker(
 *   metricsQueryBreaker,
 *   'SELECT * FROM metrics WHERE ...',
 *   [param1, param2],
 *   { rows: [], rowCount: 0, command: '', oid: 0, fields: [] }
 * );
 */
export async function withCircuitBreaker<T extends QueryResult>(
  breaker: DbCircuitBreaker,
  query: string,
  params: unknown[],
  fallback: T
): Promise<T> {
  try {
    return await breaker.fire(query, params) as T;
  } catch (error) {
    if (error instanceof Error && error.message.includes('Breaker is open')) {
      logger.warn({ query: query.substring(0, 100) }, 'Query rejected - circuit breaker open');
      return fallback;
    }
    throw error;
  }
}

/**
 * Gets the current health status of all circuit breakers.
 *
 * @returns Object with health status for each breaker
 */
export function getCircuitBreakerHealth(): Record<
  string,
  { state: string; stats: { failures: number; successes: number; rejects: number } }
> {
  const breakers: Array<{ breaker: DbCircuitBreaker; name: string }> = [
    { breaker: metricsQueryBreaker, name: 'metrics-query' },
    { breaker: metricsIngestBreaker, name: 'metrics-ingest' },
    { breaker: dashboardQueryBreaker, name: 'dashboard-query' },
  ];

  const health: Record<
    string,
    { state: string; stats: { failures: number; successes: number; rejects: number } }
  > = {};

  for (const { breaker, name } of breakers) {
    const stats = breaker.stats;
    health[name] = {
      state: breaker.opened ? 'open' : breaker.halfOpen ? 'half-open' : 'closed',
      stats: {
        failures: stats.failures,
        successes: stats.successes,
        rejects: stats.rejects,
      },
    };
  }

  return health;
}

export default {
  createDbCircuitBreaker,
  metricsQueryBreaker,
  metricsIngestBreaker,
  dashboardQueryBreaker,
  withCircuitBreaker,
  getCircuitBreakerHealth,
  emptyQueryResult,
};
