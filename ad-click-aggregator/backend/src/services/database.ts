/**
 * @fileoverview PostgreSQL database connection pool and query utilities.
 * Provides connection pooling, parameterized queries, and transaction support
 * for storing raw click events and aggregated analytics data.
 */

import { Pool, PoolClient } from 'pg';

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
  console.error('Unexpected error on idle client', err);
});

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
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  console.log('Executed query', { text: text.substring(0, 100), duration, rows: result.rowCount });
  return result.rows as T[];
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
  try {
    await pool.query('SELECT NOW()');
    return true;
  } catch (error) {
    console.error('Database connection failed:', error);
    return false;
  }
}

export default pool;
