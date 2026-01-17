import { Pool } from 'pg';

/**
 * PostgreSQL connection pool for the Apple Pay backend.
 * Provides connection pooling for efficient database access across all services.
 * Configured with sensible defaults for connection management and timeouts.
 */
const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  user: process.env.POSTGRES_USER || 'applepay',
  password: process.env.POSTGRES_PASSWORD || 'applepay_secret',
  database: process.env.POSTGRES_DB || 'applepay',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

/**
 * Executes a parameterized SQL query against the database.
 * Wraps the pool query with logging for debugging and performance monitoring.
 * All database operations should use this function for consistency.
 *
 * @param text - The SQL query string with optional $1, $2, etc. placeholders
 * @param params - Array of parameter values to substitute into the query
 * @returns Promise resolving to the query result with rows and metadata
 */
export const query = async (text: string, params?: unknown[]) => {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  console.log('Executed query', { text: text.substring(0, 50), duration, rows: res.rowCount });
  return res;
};

/**
 * Acquires a dedicated database client from the connection pool.
 * Use this when you need to run multiple queries in a transaction.
 * Remember to release the client when done to avoid connection leaks.
 *
 * @returns Promise resolving to a dedicated PoolClient connection
 */
export const getClient = async () => {
  const client = await pool.connect();
  return client;
};

export default pool;
