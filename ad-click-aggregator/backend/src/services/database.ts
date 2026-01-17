/**
 * @fileoverview PostgreSQL database connection pool and query utilities.
 * Provides connection pooling, parameterized queries, and transaction support
 * for storing raw click events and aggregated analytics data.
 */

import { Pool, PoolClient } from 'pg';
import { logger, logHelpers } from '../shared/logger.js';
import { dbMetrics } from '../shared/metrics.js';

const log = logger.child({ service: 'database' });

/**
 * PostgreSQL connection pool configured from environment variables.
 * Uses sensible defaults for local development with connection limits
 * suitable for high-throughput click ingestion.
 */
const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  database: process.env.POSTGRES_DB || 'adclick_aggregator',
  user: process.env.POSTGRES_USER || 'adclick',
  password: process.env.POSTGRES_PASSWORD || 'adclick123',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  log.error({ error: err.message }, 'Unexpected error on idle client');
  dbMetrics.errors.inc({ operation: 'idle', error_type: 'unexpected_error' });
});

pool.on('connect', () => {
  log.debug('New database client connected');
});

/**
 * Updates pool size metrics for monitoring
 */
function updatePoolMetrics(): void {
  dbMetrics.poolSize.set({ state: 'total' }, pool.totalCount);
  dbMetrics.poolSize.set({ state: 'idle' }, pool.idleCount);
  dbMetrics.poolSize.set({ state: 'waiting' }, pool.waitingCount);
}

/**
 * Executes a parameterized SQL query and returns typed results.
 * Logs query execution time for performance monitoring.
 *
 * @template T - The expected row type in the result set
 * @param text - SQL query string with $1, $2, etc. placeholders
 * @param params - Optional array of parameter values to bind
 * @returns Array of rows matching the generic type T
 */
export async function query<T = unknown>(text: string, params?: unknown[]): Promise<T[]> {
  const start = Date.now();
  const operation = extractOperation(text);
  const table = extractTable(text);

  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    const durationSeconds = duration / 1000;

    // Update metrics
    dbMetrics.queryLatency.observe({ operation, table }, durationSeconds);
    updatePoolMetrics();

    // Log query execution
    logHelpers.queryExecuted(log, text, duration, result.rowCount);

    return result.rows as T[];
  } catch (error) {
    const duration = Date.now() - start;
    log.error({ error, query: text.substring(0, 100), duration }, 'Query failed');
    dbMetrics.errors.inc({ operation, error_type: 'query_error' });
    throw error;
  }
}

/**
 * Extracts the SQL operation type from a query string
 */
function extractOperation(query: string): string {
  const normalized = query.trim().toUpperCase();
  if (normalized.startsWith('SELECT')) return 'select';
  if (normalized.startsWith('INSERT')) return 'insert';
  if (normalized.startsWith('UPDATE')) return 'update';
  if (normalized.startsWith('DELETE')) return 'delete';
  return 'other';
}

/**
 * Extracts the table name from a query string (best effort)
 */
function extractTable(query: string): string {
  const normalized = query.toLowerCase();

  // Match FROM table or INTO table
  const fromMatch = normalized.match(/(?:from|into|update)\s+(\w+)/);
  if (fromMatch) return fromMatch[1];

  return 'unknown';
}

/**
 * Acquires a client from the connection pool for manual transaction control.
 * Caller is responsible for releasing the client back to the pool.
 *
 * @returns A connected PoolClient for executing queries
 */
export async function getClient(): Promise<PoolClient> {
  return pool.connect();
}

/**
 * Executes a function within a database transaction.
 * Automatically handles BEGIN, COMMIT, and ROLLBACK on error.
 * Useful for operations that require atomicity (e.g., multi-table updates).
 *
 * @template T - Return type of the transaction function
 * @param fn - Async function receiving a PoolClient to execute transactional queries
 * @returns The result of the transaction function
 * @throws Rethrows any error after rolling back the transaction
 */
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Tests the database connection by executing a simple query.
 * Used by the health check endpoint to verify database availability.
 *
 * @returns True if connection succeeds, false otherwise
 */
export async function testConnection(): Promise<boolean> {
  const start = Date.now();
  try {
    await pool.query('SELECT NOW()');
    const duration = (Date.now() - start) / 1000;
    dbMetrics.queryLatency.observe({ operation: 'select', table: 'health' }, duration);
    updatePoolMetrics();
    return true;
  } catch (error) {
    log.error({ error }, 'Database connection failed');
    dbMetrics.errors.inc({ operation: 'health', error_type: 'connection_error' });
    return false;
  }
}

export default pool;
