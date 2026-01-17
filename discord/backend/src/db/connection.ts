/**
 * Database Connection Module
 *
 * Provides a PostgreSQL connection pool for the Baby Discord application.
 * Uses the pg library with connection pooling for efficient database access.
 * The pool is configured via DATABASE_URL environment variable or defaults
 * to local development settings.
 */

import pg from 'pg';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

/**
 * PostgreSQL connection pool instance.
 * Configured with sensible defaults for a chat application:
 * - max: 20 connections (handles concurrent requests)
 * - idleTimeoutMillis: 30s (frees idle connections)
 * - connectionTimeoutMillis: 2s (fast failure on connection issues)
 */
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgresql://discord:discord@localhost:5432/babydiscord',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  logger.error('Unexpected error on idle database client', err);
});

pool.on('connect', () => {
  logger.debug('New database connection established');
});

/**
 * Database access object providing query methods and connection management.
 * This is the primary interface for database operations throughout the application.
 */
export const db = {
  /**
   * Execute a SQL query with optional parameters.
   * Uses prepared statements for SQL injection protection.
   *
   * @template T - Expected row type for the query result
   * @param text - SQL query string with $1, $2... placeholders
   * @param params - Parameter values to substitute into the query
   * @returns Promise resolving to the query result with typed rows
   *
   * @example
   * const result = await db.query<User>('SELECT * FROM users WHERE id = $1', [userId]);
   * const user = result.rows[0];
   */
  query: <T extends pg.QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<pg.QueryResult<T>> => {
    return pool.query<T>(text, params);
  },

  /**
   * Acquire a dedicated client from the pool for transaction support.
   * The caller is responsible for releasing the client after use.
   *
   * @returns Promise resolving to a PoolClient that must be released
   *
   * @example
   * const client = await db.getClient();
   * try {
   *   await client.query('BEGIN');
   *   // ... transactional operations
   *   await client.query('COMMIT');
   * } catch {
   *   await client.query('ROLLBACK');
   * } finally {
   *   client.release();
   * }
   */
  getClient: async () => {
    const client = await pool.connect();
    return client;
  },

  /**
   * Check if the database connection is healthy.
   * Used by health check endpoints to verify database availability.
   *
   * @returns Promise resolving to true if database is reachable, false otherwise
   */
  async healthCheck(): Promise<boolean> {
    try {
      await pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Close all connections in the pool.
   * Should be called during graceful shutdown.
   *
   * @returns Promise that resolves when all connections are closed
   */
  async close(): Promise<void> {
    await pool.end();
  },
};

export default db;
