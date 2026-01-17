import { Pool, PoolClient, QueryResult } from 'pg';
import { DB_CONFIG } from '../config.js';
import logger from './logger.js';
import { dbQueryDuration, dbConnectionsActive } from './metrics.js';
import { createCircuitBreaker, dbCircuitBreakerOptions } from './circuitBreaker.js';

/**
 * PostgreSQL connection pool for the application.
 * Manages a pool of reusable database connections to optimize performance
 * and prevent connection exhaustion under high load.
 */
export const pool = new Pool({
  host: DB_CONFIG.host,
  port: DB_CONFIG.port,
  database: DB_CONFIG.database,
  user: DB_CONFIG.user,
  password: DB_CONFIG.password,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Track pool events for monitoring
pool.on('connect', () => {
  dbConnectionsActive.inc();
  logger.debug('New database connection created');
});

pool.on('remove', () => {
  dbConnectionsActive.dec();
  logger.debug('Database connection removed');
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected database pool error');
});

/**
 * Returns the current database connection state.
 * Used by health check endpoints.
 */
export async function isDatabaseConnected(): Promise<boolean> {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    return true;
  } catch {
    return false;
  }
}

/**
 * Tests the database connection on startup.
 * Verifies that the PostgreSQL server is reachable and credentials are valid.
 * @returns Promise resolving to true if connection succeeds, false otherwise
 */
export async function testConnection(): Promise<boolean> {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    logger.info('Database connection successful');
    return true;
  } catch (error) {
    logger.error({ err: error }, 'Database connection failed');
    return false;
  }
}

/**
 * Internal query function without circuit breaker.
 * Used by the circuit breaker wrapper.
 */
async function executeQuery(text: string, params?: unknown[]): Promise<QueryResult> {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;

  // Record query duration in metrics
  const operation = text.trim().split(' ')[0].toUpperCase();
  dbQueryDuration.observe({ operation }, duration / 1000);

  if (duration > 100) {
    logger.warn({ text, duration, rows: result.rowCount }, 'Slow query detected');
  } else {
    logger.debug({ text: text.substring(0, 50), duration, rows: result.rowCount }, 'Query executed');
  }

  return result;
}

/**
 * Circuit breaker for database queries.
 * Opens when queries consistently fail, allowing the database to recover.
 */
const queryBreaker = createCircuitBreaker(
  executeQuery,
  'database',
  dbCircuitBreakerOptions
);

// Configure fallback for when circuit is open
queryBreaker.fallback(() => {
  throw new Error('Database circuit breaker is open - service temporarily unavailable');
});

/**
 * Executes a SQL query with optional parameters, circuit breaker protection, and timing.
 * Logs slow queries (>100ms) for performance monitoring.
 * @param text - SQL query string with $1, $2... placeholders
 * @param params - Array of parameter values to bind
 * @returns Promise resolving to array of typed result rows
 */
export async function query<T>(text: string, params?: unknown[]): Promise<T[]> {
  const result = await queryBreaker.fire(text, params);
  return result.rows as T[];
}

/**
 * Executes a query directly without circuit breaker protection.
 * Use this for health checks and critical operations that must bypass the circuit.
 * @param text - SQL query string
 * @param params - Array of parameter values
 * @returns Promise resolving to array of typed result rows
 */
export async function queryDirect<T>(text: string, params?: unknown[]): Promise<T[]> {
  const result = await executeQuery(text, params);
  return result.rows as T[];
}

/**
 * Executes a callback within a database transaction.
 * Automatically handles BEGIN, COMMIT, and ROLLBACK for atomicity.
 * Used for operations that require multiple queries to succeed together.
 * @param callback - Function receiving a PoolClient to execute queries
 * @returns Promise resolving to the callback's return value
 */
export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    logger.debug('Transaction committed');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error({ err: error }, 'Transaction rolled back');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Closes all connections in the pool during graceful shutdown.
 * Called when the server receives SIGTERM or SIGINT signals.
 * @returns Promise that resolves when all connections are closed
 */
export async function closePool(): Promise<void> {
  await pool.end();
  logger.info('Database pool closed');
}

/**
 * Returns the current circuit breaker state.
 * @returns Object with circuit breaker status information
 */
export function getCircuitBreakerStatus(): {
  state: string;
  stats: {
    failures: number;
    successes: number;
    rejects: number;
    fires: number;
    timeouts: number;
  };
} {
  const stats = queryBreaker.stats;
  return {
    state: queryBreaker.opened ? 'open' : queryBreaker.halfOpen ? 'half-open' : 'closed',
    stats: {
      failures: stats.failures,
      successes: stats.successes,
      rejects: stats.rejects,
      fires: stats.fires,
      timeouts: stats.timeouts,
    },
  };
}
