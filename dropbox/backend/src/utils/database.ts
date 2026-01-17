/**
 * PostgreSQL database connection pool and query utilities.
 * Provides the data layer for all persistent storage including users, files,
 * chunks, sessions, and sharing metadata.
 * @module utils/database
 */

import { Pool, PoolConfig } from 'pg';

/** PostgreSQL connection pool configuration with sensible defaults for local development */
const config: PoolConfig = {
  connectionString: process.env.DATABASE_URL || 'postgres://dropbox:dropbox_password@localhost:5432/dropbox',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
};

/** Shared connection pool for all database queries */
export const pool = new Pool(config);

/**
 * Executes a SQL query and returns all matching rows.
 * Generic type T allows type-safe result handling.
 * @param text - SQL query string with $1, $2... placeholders
 * @param params - Parameter values to bind to placeholders
 * @returns Array of rows cast to type T
 */
export async function query<T>(text: string, params?: unknown[]): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

/**
 * Executes a SQL query expecting at most one row.
 * Useful for lookups by primary key or unique constraints.
 * @param text - SQL query string with $1, $2... placeholders
 * @param params - Parameter values to bind to placeholders
 * @returns Single row of type T, or null if no match
 */
export async function queryOne<T>(text: string, params?: unknown[]): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Executes multiple queries within an atomic database transaction.
 * Automatically handles BEGIN, COMMIT, and ROLLBACK on error.
 * Used for operations requiring data consistency like file creation with chunks.
 * @param callback - Async function receiving a client for executing queries
 * @returns Result from the callback function
 * @throws Re-throws any error after rolling back the transaction
 */
export async function transaction<T>(callback: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
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
