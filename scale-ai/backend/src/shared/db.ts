/**
 * PostgreSQL database connection module.
 * Provides a connection pool and transaction helper for database operations.
 * Used by all backend services for persistent data storage.
 * @module shared/db
 */

import pg from 'pg'

const { Pool } = pg

/**
 * PostgreSQL connection pool instance.
 * Configured via environment variables with sensible defaults for local development.
 * The pool manages up to 20 connections with idle timeout and connection timeout limits.
 */
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'scaleai',
  user: process.env.DB_USER || 'scaleai',
  password: process.env.DB_PASSWORD || 'scaleai123',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
})

// Test connection on startup
pool.on('connect', () => {
  console.log('Connected to PostgreSQL')
})

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err)
})

export { pool }

/**
 * Executes a callback function within a database transaction.
 * Automatically handles BEGIN, COMMIT, and ROLLBACK for safe atomic operations.
 * Essential for operations that modify multiple tables or require consistency guarantees.
 *
 * @template T - The return type of the callback function
 * @param callback - Async function that receives a PoolClient and performs database operations
 * @returns Promise resolving to the callback's return value
 * @throws Rethrows any error from the callback after rolling back the transaction
 *
 * @example
 * ```typescript
 * const result = await withTransaction(async (client) => {
 *   await client.query('INSERT INTO drawings ...');
 *   await client.query('UPDATE users SET total_drawings = ...');
 *   return { success: true };
 * });
 * ```
 */
export async function withTransaction<T>(
  callback: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
