/**
 * PostgreSQL Database Connection Module
 *
 * Provides a connection pool and helper functions for database operations.
 * Uses connection pooling for efficient resource management under high load.
 * Includes circuit breaker pattern for resilience and structured logging.
 *
 * @module db
 */

import { Pool, PoolClient, QueryResult } from 'pg';
import {
  logger,
  createDatabaseCircuitBreaker,
  dbQueryDurationHistogram,
  dbPoolGauge,
} from '../shared/index.js';

const dbLogger = logger.child({ module: 'database' });

/**
 * PostgreSQL connection pool configured for high-throughput live comment operations.
 * - max: 20 connections to handle concurrent comment writes
 * - idleTimeoutMillis: 30s before releasing idle connections
 * - connectionTimeoutMillis: 2s timeout for new connections
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/live_comments',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  dbLogger.error({ error: err.message }, 'Unexpected error on idle client');
  process.exit(-1);
});

pool.on('connect', () => {
  dbLogger.debug('New database connection established');
  updatePoolMetrics();
});

pool.on('remove', () => {
  dbLogger.debug('Database connection removed from pool');
  updatePoolMetrics();
});

/**
 * Updates Prometheus metrics for connection pool status.
 */
function updatePoolMetrics(): void {
  dbPoolGauge.labels('total').set(pool.totalCount);
  dbPoolGauge.labels('idle').set(pool.idleCount);
  dbPoolGauge.labels('waiting').set(pool.waitingCount);
}

/**
 * Internal query function that performs the actual database query.
 * This is wrapped by the circuit breaker.
 */
async function executeQuery<T>(text: string, params?: unknown[]): Promise<T[]> {
  const start = Date.now();
  let success = true;

  try {
    const res = await pool.query(text, params);
    return res.rows as T[];
  } catch (error) {
    success = false;
    throw error;
  } finally {
    const duration = Date.now() - start;
    const queryType = extractQueryType(text);

    dbQueryDurationHistogram.labels(queryType, success ? 'true' : 'false').observe(duration);
    updatePoolMetrics();

    dbLogger.debug({
      query: text.substring(0, 80),
      duration,
      rows: success ? 'ok' : 'error',
      queryType,
    }, 'Query executed');
  }
}

/**
 * Extracts the query type (SELECT, INSERT, UPDATE, DELETE) for metrics.
 */
function extractQueryType(text: string): string {
  const normalized = text.trim().toUpperCase();
  if (normalized.startsWith('SELECT')) return 'SELECT';
  if (normalized.startsWith('INSERT')) return 'INSERT';
  if (normalized.startsWith('UPDATE')) return 'UPDATE';
  if (normalized.startsWith('DELETE')) return 'DELETE';
  if (normalized.startsWith('BEGIN')) return 'BEGIN';
  if (normalized.startsWith('COMMIT')) return 'COMMIT';
  if (normalized.startsWith('ROLLBACK')) return 'ROLLBACK';
  return 'OTHER';
}

/**
 * Circuit-breaker protected query function.
 * Automatically opens circuit after repeated failures to prevent cascading issues.
 */
const protectedQuery = createDatabaseCircuitBreaker(executeQuery, 'query');

/**
 * Executes a SQL query and returns typed results.
 * Protected by circuit breaker for resilience.
 *
 * @template T - The expected row type
 * @param text - SQL query string with $1, $2, etc. placeholders
 * @param params - Parameter values for the query placeholders
 * @returns Array of typed result rows
 */
export async function query<T>(text: string, params?: unknown[]): Promise<T[]> {
  return protectedQuery<T>(text, params);
}

/**
 * Acquires a client from the connection pool.
 * Caller is responsible for releasing the client back to the pool.
 *
 * @returns A connected PoolClient instance
 */
export async function getClient(): Promise<PoolClient> {
  const client = await pool.connect();
  updatePoolMetrics();
  return client;
}

/**
 * Executes a callback within a database transaction.
 * Automatically handles BEGIN, COMMIT, and ROLLBACK.
 *
 * @template T - Return type of the callback
 * @param callback - Async function receiving the transaction client
 * @returns The result of the callback
 * @throws Re-throws any error after rolling back the transaction
 */
export async function transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const start = Date.now();

  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');

    dbLogger.debug({ duration: Date.now() - start }, 'Transaction committed');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    dbLogger.warn({ error: (e as Error).message, duration: Date.now() - start }, 'Transaction rolled back');
    throw e;
  } finally {
    client.release();
    updatePoolMetrics();
  }
}

/**
 * Checks if the database connection is healthy.
 * Used by health check endpoints.
 *
 * @returns true if database is reachable, false otherwise
 */
export async function isHealthy(): Promise<boolean> {
  try {
    const result = await pool.query('SELECT 1 as health');
    return result.rows.length === 1;
  } catch (error) {
    dbLogger.error({ error: (error as Error).message }, 'Database health check failed');
    return false;
  }
}

/**
 * Gracefully closes the database connection pool.
 * Should be called during server shutdown.
 */
export async function close(): Promise<void> {
  dbLogger.info('Closing database connection pool');
  await pool.end();
  dbLogger.info('Database connection pool closed');
}

export { pool };
