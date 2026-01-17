/**
 * @fileoverview PostgreSQL database connection pool and query utilities.
 * Provides the main database connection used by all backend services,
 * along with helper functions for executing queries and transactions.
 */

import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

/**
 * PostgreSQL connection pool shared across the application.
 * Uses the DATABASE_URL environment variable or falls back to local defaults.
 */
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://slack:slack_password@localhost:5432/slack',
});

/**
 * Executes a parameterized SQL query with logging.
 * Logs query execution time for performance monitoring.
 * @template T - The expected row type in the query result
 * @param text - SQL query string with $1, $2, etc. placeholders
 * @param params - Array of parameter values to substitute into the query
 * @returns Promise resolving to the query result with typed rows
 */
export async function query<T>(text: string, params?: unknown[]): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  const result = await pool.query<T>(text, params);
  const duration = Date.now() - start;
  console.log('Executed query', { text: text.substring(0, 50), duration, rows: result.rowCount });
  return result;
}

/**
 * Executes a callback within a database transaction.
 * Automatically handles BEGIN, COMMIT, and ROLLBACK based on callback success/failure.
 * Ensures the client is released back to the pool after completion.
 * @template T - The return type of the callback
 * @param callback - Async function that receives a PoolClient for executing queries
 * @returns Promise resolving to the callback's return value
 * @throws Re-throws any error from the callback after rolling back the transaction
 */
export async function withTransaction<T>(
  callback: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
