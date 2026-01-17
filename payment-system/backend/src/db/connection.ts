import { Pool } from 'pg';
import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

/**
 * PostgreSQL connection pool for database operations.
 * Manages connections efficiently with configurable pool size and timeouts.
 * Used by all services requiring persistent data storage.
 */
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

/**
 * Redis client for caching and session management.
 * Used for idempotency key caching, rate limiting, and fast lookups.
 */
export const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

/**
 * System account identifiers for the double-entry ledger.
 * These are fixed UUIDs representing platform-level accounts
 * used in all financial transactions.
 */
export const SYSTEM_ACCOUNTS = {
  ACCOUNTS_RECEIVABLE: '00000000-0000-0000-0000-000000000001',
  PLATFORM_REVENUE: '00000000-0000-0000-0000-000000000002',
  PENDING_SETTLEMENTS: '00000000-0000-0000-0000-000000000003',
} as const;

/**
 * Executes a parameterized SQL query and returns all matching rows.
 * Provides type-safe database access with automatic connection handling.
 * @param text - SQL query string with $1, $2, etc. placeholders
 * @param params - Array of parameter values to substitute into the query
 * @returns Promise resolving to an array of typed result rows
 */
export async function query<T>(text: string, params?: unknown[]): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

/**
 * Executes a parameterized SQL query and returns the first matching row.
 * Useful for lookups by primary key or unique constraints.
 * @param text - SQL query string with $1, $2, etc. placeholders
 * @param params - Array of parameter values to substitute into the query
 * @returns Promise resolving to a single typed row or null if not found
 */
export async function queryOne<T>(text: string, params?: unknown[]): Promise<T | null> {
  const result = await pool.query(text, params);
  return (result.rows[0] as T) || null;
}

/**
 * Executes a callback within a database transaction for atomic operations.
 * Ensures data consistency by automatically committing on success or rolling back on error.
 * Critical for payment processing where multiple tables must be updated together.
 * @param callback - Async function receiving a PoolClient to execute queries within the transaction
 * @returns Promise resolving to the callback's return value
 * @throws Re-throws any error from the callback after rolling back the transaction
 */
export async function withTransaction<T>(
  callback: (client: import('pg').PoolClient) => Promise<T>
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

/**
 * Gracefully closes all database and cache connections.
 * Should be called during application shutdown to release resources.
 * @returns Promise that resolves when all connections are closed
 */
export async function closeConnections(): Promise<void> {
  await pool.end();
  await redis.quit();
}
