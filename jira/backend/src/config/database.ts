import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { config } from './index.js';

/**
 * PostgreSQL connection pool instance.
 * Provides connection pooling for efficient database access.
 */
export const pool = new Pool({
  connectionString: config.database.url,
});

/**
 * Executes a SQL query with optional parameters and timing logging.
 * Wraps pg's query method with development-mode performance logging.
 *
 * @template T - The expected row type extending QueryResultRow
 * @param text - SQL query string to execute
 * @param params - Optional array of parameter values for parameterized queries
 * @returns Promise resolving to the query result with typed rows
 */
export async function query<T extends QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const start = Date.now();
  const result = await pool.query<T>(text, params);
  const duration = Date.now() - start;
  if (config.nodeEnv === 'development') {
    console.log('Executed query', { text: text.substring(0, 100), duration, rows: result.rowCount });
  }
  return result;
}

/**
 * Acquires a client from the connection pool.
 * Used when multiple queries need to share a connection (e.g., transactions).
 *
 * @returns Promise resolving to a pooled client connection
 */
export async function getClient(): Promise<PoolClient> {
  const client = await pool.connect();
  return client;
}

/**
 * Executes a callback function within a database transaction.
 * Automatically handles BEGIN, COMMIT, and ROLLBACK, ensuring data consistency.
 *
 * @template T - Return type of the transaction callback
 * @param callback - Async function receiving a client to execute transactional queries
 * @returns Promise resolving to the callback's return value
 * @throws Rethrows any error after rolling back the transaction
 */
export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>
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
