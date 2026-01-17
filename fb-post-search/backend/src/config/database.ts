/**
 * @fileoverview PostgreSQL database connection pool and query utilities.
 * Provides a centralized connection pool for all database operations,
 * with helper functions for common query patterns including transactions.
 */

import { Pool } from 'pg';
import { config } from '../config/index.js';

/**
 * PostgreSQL connection pool configured from environment settings.
 * Manages a pool of reusable connections with automatic cleanup of idle connections.
 * @constant
 */
export const pool = new Pool({
  host: config.postgres.host,
  port: config.postgres.port,
  user: config.postgres.user,
  password: config.postgres.password,
  database: config.postgres.database,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

/**
 * Executes a SQL query and returns all matching rows.
 * Wraps the pg pool.query method with proper typing for results.
 * @template T - The expected row type
 * @param text - SQL query string with optional $1, $2 placeholders
 * @param params - Array of parameter values to substitute into the query
 * @returns Promise resolving to an array of typed result rows
 */
export async function query<T>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

/**
 * Executes a SQL query and returns only the first matching row.
 * Useful for queries expected to return a single result (e.g., SELECT by ID).
 * @template T - The expected row type
 * @param text - SQL query string with optional $1, $2 placeholders
 * @param params - Array of parameter values to substitute into the query
 * @returns Promise resolving to the first row or null if no results
 */
export async function queryOne<T>(
  text: string,
  params?: unknown[]
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] || null;
}

/**
 * Executes a callback function within a database transaction.
 * Automatically handles BEGIN, COMMIT, and ROLLBACK operations.
 * Ensures connection is properly released back to the pool after completion.
 * @template T - The return type of the callback
 * @param callback - Async function that receives the client and performs database operations
 * @returns Promise resolving to the callback's return value
 * @throws Re-throws any error after rolling back the transaction
 */
export async function transaction<T>(
  callback: (client: ReturnType<typeof pool.connect> extends Promise<infer C> ? C : never) => Promise<T>
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
