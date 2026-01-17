import { Pool } from 'pg';
import { DB_CONFIG } from '../config.js';

/**
 * PostgreSQL connection pool.
 * Manages a pool of database connections for efficient query execution.
 * Configured with connection limits and timeouts to prevent resource exhaustion.
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

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

/**
 * Executes a SQL query and returns all matching rows.
 * Automatically manages connection acquisition and release from the pool.
 *
 * @template T - The expected row type
 * @param text - The SQL query string with optional $1, $2, etc. placeholders
 * @param params - Array of parameter values to substitute into the query
 * @returns Promise resolving to an array of typed rows
 */
export async function query<T>(text: string, params?: unknown[]): Promise<T[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result.rows as T[];
  } finally {
    client.release();
  }
}

/**
 * Executes a SQL query and returns the first matching row or null.
 * Useful for queries expected to return a single result (e.g., by primary key).
 *
 * @template T - The expected row type
 * @param text - The SQL query string with optional placeholders
 * @param params - Array of parameter values to substitute into the query
 * @returns Promise resolving to the first row or null if no matches
 */
export async function queryOne<T>(text: string, params?: unknown[]): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] || null;
}

/**
 * Executes multiple queries within a database transaction.
 * Automatically handles BEGIN/COMMIT/ROLLBACK to ensure atomicity.
 * Used for operations that must succeed or fail together (e.g., creating account + profile).
 *
 * @template T - The return type of the callback function
 * @param callback - Async function that receives a client and performs queries
 * @returns Promise resolving to the callback's return value
 */
export async function transaction<T>(
  callback: (client: ReturnType<typeof pool.connect> extends Promise<infer C> ? C : never) => Promise<T>
): Promise<T> {
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
