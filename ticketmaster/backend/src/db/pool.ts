/**
 * PostgreSQL connection pool for the Ticketmaster backend.
 * Provides database connectivity with connection pooling and transaction support.
 * PostgreSQL is used as the primary data store for ACID compliance in ticket transactions.
 */
import { Pool, PoolClient } from 'pg';

/**
 * PostgreSQL connection pool instance.
 * Configured with sensible defaults for connection management.
 */
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'ticketmaster',
  password: process.env.DB_PASSWORD || 'ticketmaster_secret',
  database: process.env.DB_NAME || 'ticketmaster',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

/**
 * Executes a SQL query with optional parameters and logs slow queries.
 * This is the primary method for database operations throughout the application.
 * Queries exceeding 100ms are logged for performance monitoring.
 *
 * @param text - The SQL query string
 * @param params - Optional array of parameter values for parameterized queries
 * @returns The query result with rows and metadata
 */
export const query = async (text: string, params?: unknown[]) => {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  if (duration > 100) {
    console.log('Slow query:', { text: text.substring(0, 100), duration, rows: result.rowCount });
  }
  return result;
};

/**
 * Acquires a client from the connection pool for direct use.
 * The caller is responsible for releasing the client back to the pool.
 * Use withTransaction for most use cases requiring a dedicated client.
 *
 * @returns A connected PoolClient instance
 */
export const getClient = async (): Promise<PoolClient> => {
  const client = await pool.connect();
  return client;
};

/**
 * Executes a callback function within a database transaction.
 * Automatically handles BEGIN, COMMIT, and ROLLBACK based on success/failure.
 * This ensures atomicity for operations like seat reservation and checkout.
 *
 * @template T - The return type of the callback function
 * @param callback - Async function that receives a PoolClient and performs database operations
 * @returns The result of the callback function
 * @throws Re-throws any error after rolling back the transaction
 */
export const withTransaction = async <T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> => {
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
};

export default pool;
