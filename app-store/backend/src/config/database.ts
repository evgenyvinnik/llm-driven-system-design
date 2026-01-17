/**
 * @fileoverview PostgreSQL database connection and query utilities.
 * Provides connection pooling, query logging, and transaction support.
 */

import { Pool } from 'pg';
import { config } from './index.js';

/**
 * PostgreSQL connection pool for managing database connections.
 * Automatically handles connection lifecycle and pooling.
 */
export const pool = new Pool({
  connectionString: config.database.url,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

/**
 * Executes a SQL query with optional parameters and logs execution time in development.
 * @param text - SQL query string with $1, $2, etc. placeholders
 * @param params - Array of parameter values to substitute into the query
 * @returns Query result containing rows and metadata
 */
export async function query(text: string, params?: unknown[]) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  if (config.nodeEnv === 'development') {
    console.log('Executed query', { text: text.substring(0, 50), duration, rows: result.rowCount });
  }
  return result;
}

/**
 * Acquires a dedicated client from the pool with automatic timeout warning.
 * Use for operations requiring multiple queries on the same connection.
 * Caller is responsible for calling release() when done.
 * @returns Pool client with enhanced release method
 */
export async function getClient() {
  const client = await pool.connect();
  const originalQuery = client.query.bind(client);
  const release = client.release.bind(client);

  const timeout = setTimeout(() => {
    console.error('A client has been checked out for more than 5 seconds!');
  }, 5000);

  client.release = () => {
    clearTimeout(timeout);
    return release();
  };

  return client;
}

/**
 * Executes a callback within a database transaction with automatic commit/rollback.
 * Ensures atomicity for multi-query operations like creating reviews and updating ratings.
 * @template T - Return type of the callback
 * @param callback - Function receiving a client to execute transactional queries
 * @returns Result from the callback function
 * @throws Re-throws any error after rolling back the transaction
 */
export async function transaction<T>(
  callback: (client: ReturnType<typeof pool.connect> extends Promise<infer C> ? C : never) => Promise<T>
): Promise<T> {
  const client = await getClient();
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
