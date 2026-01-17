/**
 * PostgreSQL Database Connection Module
 *
 * Provides a connection pool and helper functions for database operations.
 * Uses connection pooling for efficient resource management under high load.
 *
 * @module db
 */

import { Pool, PoolClient } from 'pg';

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
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

/**
 * Executes a SQL query and returns typed results.
 * Logs query execution time for performance monitoring.
 *
 * @template T - The expected row type
 * @param text - SQL query string with $1, $2, etc. placeholders
 * @param params - Parameter values for the query placeholders
 * @returns Array of typed result rows
 */
export async function query<T>(text: string, params?: unknown[]): Promise<T[]> {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  console.log('Executed query', { text: text.substring(0, 50), duration, rows: res.rowCount });
  return res.rows as T[];
}

/**
 * Acquires a client from the connection pool.
 * Caller is responsible for releasing the client back to the pool.
 *
 * @returns A connected PoolClient instance
 */
export async function getClient(): Promise<PoolClient> {
  return pool.connect();
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
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export { pool };
