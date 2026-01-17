import pg from 'pg';

const { Pool } = pg;

/**
 * PostgreSQL connection pool for database operations.
 * Configured with environment variables or sensible defaults for local development.
 * Used throughout the backend for all database queries.
 */
export const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'facetime',
  password: process.env.DB_PASSWORD || 'facetime_dev_password',
  database: process.env.DB_NAME || 'facetime',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

/** Valid parameter types for PostgreSQL queries */
type QueryParam = string | number | boolean | null | undefined | string[] | number[];

/**
 * Executes a parameterized SQL query and returns all matching rows.
 * Provides type-safe database access with support for parameterized queries
 * to prevent SQL injection.
 *
 * @param text - The SQL query string with $1, $2, etc. placeholders
 * @param params - Optional array of parameter values to substitute
 * @returns Promise resolving to an array of typed result rows
 */
export async function query<T>(
  text: string,
  params?: QueryParam[]
): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

/**
 * Executes a parameterized SQL query and returns a single row or null.
 * Convenience wrapper around query() for lookups expecting at most one result.
 *
 * @param text - The SQL query string with $1, $2, etc. placeholders
 * @param params - Optional array of parameter values to substitute
 * @returns Promise resolving to a single typed row or null if not found
 */
export async function queryOne<T>(
  text: string,
  params?: QueryParam[]
): Promise<T | null> {
  const result = await query<T>(text, params);
  return result.length > 0 ? result[0] : null;
}

/**
 * Tests the database connection by executing a simple query.
 * Used during server startup to verify PostgreSQL connectivity
 * and provide clear feedback if the database is unavailable.
 *
 * @returns Promise resolving to true if connected, false otherwise
 */
export async function testConnection(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    console.log('Database connection established');
    return true;
  } catch (error) {
    console.error('Database connection failed:', error);
    return false;
  }
}
