/**
 * PostgreSQL database connection and query utilities.
 *
 * Provides a connection pool for efficient database access and
 * helper functions for common query patterns.
 */
import { Pool } from 'pg';

/**
 * PostgreSQL connection pool.
 * Configured with sensible defaults for a development environment.
 * Manages up to 20 concurrent connections with automatic cleanup.
 */
export const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  user: process.env.POSTGRES_USER || 'rplace',
  password: process.env.POSTGRES_PASSWORD || 'rplace_dev',
  database: process.env.POSTGRES_DB || 'rplace',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

pool.on('connect', () => {
  console.log('PostgreSQL pool connection established');
});

/**
 * Executes a SQL query and returns all matching rows.
 *
 * @template T - The expected shape of each returned row.
 * @param text - The SQL query string with $1, $2, etc. placeholders.
 * @param params - Optional array of parameter values for the placeholders.
 * @returns Promise resolving to an array of typed rows.
 */
export async function query<T>(text: string, params?: unknown[]): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

/**
 * Executes a SQL query and returns the first matching row.
 * Useful for queries expected to return at most one result.
 *
 * @template T - The expected shape of the returned row.
 * @param text - The SQL query string with $1, $2, etc. placeholders.
 * @param params - Optional array of parameter values for the placeholders.
 * @returns Promise resolving to a single typed row or null if not found.
 */
export async function queryOne<T>(text: string, params?: unknown[]): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] || null;
}
