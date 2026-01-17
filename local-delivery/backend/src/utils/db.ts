import { Pool } from 'pg';

/**
 * PostgreSQL connection pool for database operations.
 * Configured with environment variables or sensible defaults for local development.
 * Essential for all database interactions in the delivery platform.
 */
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'delivery',
  user: process.env.DB_USER || 'delivery',
  password: process.env.DB_PASSWORD || 'delivery_secret',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

export { pool };

/**
 * Executes a SQL query and returns all matching rows.
 * Use this for SELECT queries that return multiple rows.
 *
 * @param text - The SQL query string with optional $1, $2, ... placeholders
 * @param params - Optional array of parameter values to substitute into the query
 * @returns Promise resolving to an array of typed rows
 */
export async function query<T>(text: string, params?: unknown[]): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

/**
 * Executes a SQL query and returns the first row or null.
 * Use this for queries expected to return a single row (e.g., by ID lookup).
 *
 * @param text - The SQL query string with optional $1, $2, ... placeholders
 * @param params - Optional array of parameter values to substitute into the query
 * @returns Promise resolving to the first row or null if no rows match
 */
export async function queryOne<T>(text: string, params?: unknown[]): Promise<T | null> {
  const result = await pool.query(text, params);
  return (result.rows[0] as T) || null;
}

/**
 * Executes a SQL statement and returns the number of affected rows.
 * Use this for INSERT, UPDATE, or DELETE statements where you need the row count.
 *
 * @param text - The SQL statement with optional $1, $2, ... placeholders
 * @param params - Optional array of parameter values to substitute into the statement
 * @returns Promise resolving to the number of rows affected
 */
export async function execute(text: string, params?: unknown[]): Promise<number> {
  const result = await pool.query(text, params);
  return result.rowCount || 0;
}
