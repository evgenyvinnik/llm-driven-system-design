/**
 * PostgreSQL connection pool module.
 * Provides database connectivity with connection pooling for efficient query execution.
 * Used by all database operations in the job scheduler.
 * @module db/pool
 */

import { Pool, PoolConfig } from 'pg';
import { logger } from '../utils/logger';

/** Pool configuration with sensible defaults for the job scheduler workload */
const poolConfig: PoolConfig = {
  connectionString: process.env.DATABASE_URL || 'postgres://scheduler:scheduler@localhost:5432/job_scheduler',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
};

/**
 * PostgreSQL connection pool instance.
 * Manages a pool of reusable database connections for concurrent operations.
 */
export const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  logger.error('Unexpected error on idle client', err);
});

pool.on('connect', () => {
  logger.debug('New client connected to PostgreSQL');
});

/**
 * Executes a SQL query and returns the result rows.
 * Logs query duration for performance monitoring.
 * @template T - The expected row type
 * @param text - SQL query string with optional $1, $2, etc. placeholders
 * @param params - Parameter values to substitute into the query
 * @returns Array of result rows typed as T
 * @throws Database errors are logged and re-thrown
 */
export async function query<T>(text: string, params?: unknown[]): Promise<T[]> {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    logger.debug(`Query executed in ${duration}ms`, { text: text.substring(0, 100), rowCount: result.rowCount });
    return result.rows as T[];
  } catch (error) {
    logger.error('Database query error', { text: text.substring(0, 100), error });
    throw error;
  }
}

/**
 * Executes a SQL query and returns the first row or null.
 * Convenience wrapper for queries expected to return a single row.
 * @template T - The expected row type
 * @param text - SQL query string
 * @param params - Parameter values to substitute
 * @returns First result row or null if no rows returned
 */
export async function queryOne<T>(text: string, params?: unknown[]): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] || null;
}

/**
 * Executes a callback within a database transaction.
 * Automatically handles BEGIN, COMMIT, and ROLLBACK.
 * Ensures atomicity for multi-statement operations like job scheduling.
 * @template T - The return type of the callback
 * @param callback - Function receiving a query interface to execute within the transaction
 * @returns Result from the callback function
 * @throws Rolls back transaction and re-throws any errors from the callback
 */
export async function transaction<T>(
  callback: (client: { query: typeof query }) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const clientQuery = async <R>(text: string, params?: unknown[]): Promise<R[]> => {
      const result = await client.query(text, params);
      return result.rows as R[];
    };
    const result = await callback({ query: clientQuery });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Checks if the database connection is healthy.
 * Used by health check endpoints to verify database availability.
 * @returns True if the database is reachable, false otherwise
 */
export async function healthCheck(): Promise<boolean> {
  try {
    await query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
