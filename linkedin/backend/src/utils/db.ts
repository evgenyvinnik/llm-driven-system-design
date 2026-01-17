import { Pool, PoolConfig } from 'pg';

/**
 * PostgreSQL connection pool configuration.
 * Uses environment variables for production, with sensible local development defaults.
 * Pool maintains up to 20 concurrent connections with automatic cleanup.
 */
const poolConfig: PoolConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'linkedin',
  user: process.env.DB_USER || 'linkedin',
  password: process.env.DB_PASSWORD || 'linkedin_password',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
};

/**
 * PostgreSQL connection pool singleton.
 * Shared across all database operations to efficiently manage connections.
 * Automatically handles connection lifecycle and reuse.
 */
export const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

/**
 * Executes a SQL query and returns all matching rows.
 * Used for SELECT queries that return multiple records.
 *
 * @template T - The expected type of each row
 * @param text - The SQL query string with optional $1, $2, etc. placeholders
 * @param params - Optional array of parameter values to substitute into the query
 * @returns Promise resolving to an array of typed rows
 */
export async function query<T = unknown>(text: string, params?: unknown[]): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

/**
 * Executes a SQL query and returns the first matching row or null.
 * Ideal for lookups by primary key or unique constraints.
 *
 * @template T - The expected type of the row
 * @param text - The SQL query string with optional $1, $2, etc. placeholders
 * @param params - Optional array of parameter values to substitute into the query
 * @returns Promise resolving to a single typed row, or null if no match found
 */
export async function queryOne<T = unknown>(text: string, params?: unknown[]): Promise<T | null> {
  const result = await pool.query(text, params);
  return (result.rows[0] as T) || null;
}

/**
 * Executes a SQL statement that modifies data (INSERT, UPDATE, DELETE).
 * Returns the number of affected rows for verification.
 *
 * @param text - The SQL statement with optional $1, $2, etc. placeholders
 * @param params - Optional array of parameter values to substitute into the statement
 * @returns Promise resolving to the count of affected rows
 */
export async function execute(text: string, params?: unknown[]): Promise<number> {
  const result = await pool.query(text, params);
  return result.rowCount || 0;
}
