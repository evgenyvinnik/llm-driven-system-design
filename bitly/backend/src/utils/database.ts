import { Pool, PoolClient } from 'pg';
import { DB_CONFIG } from '../config.js';

/**
 * PostgreSQL connection pool for the application.
 * Manages a pool of reusable database connections to optimize performance
 * and prevent connection exhaustion under high load.
 */
export const pool = new Pool({
  host: DB_CONFIG.host,
  port: DB_CONFIG.port,
  database: DB_CONFIG.database,
  user: DB_CONFIG.user,
  password: DB_CONFIG.password,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

/**
 * Tests the database connection on startup.
 * Verifies that the PostgreSQL server is reachable and credentials are valid.
 * @returns Promise resolving to true if connection succeeds, false otherwise
 */
export async function testConnection(): Promise<boolean> {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    console.log('Database connection successful');
    return true;
  } catch (error) {
    console.error('Database connection failed:', error);
    return false;
  }
}

/**
 * Executes a SQL query with optional parameters and timing.
 * Logs slow queries (>100ms) for performance monitoring.
 * @param text - SQL query string with $1, $2... placeholders
 * @param params - Array of parameter values to bind
 * @returns Promise resolving to array of typed result rows
 */
export async function query<T>(text: string, params?: unknown[]): Promise<T[]> {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;

  if (duration > 100) {
    console.log('Slow query:', { text, duration, rows: result.rowCount });
  }

  return result.rows as T[];
}

/**
 * Executes a callback within a database transaction.
 * Automatically handles BEGIN, COMMIT, and ROLLBACK for atomicity.
 * Used for operations that require multiple queries to succeed together.
 * @param callback - Function receiving a PoolClient to execute queries
 * @returns Promise resolving to the callback's return value
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

/**
 * Closes all connections in the pool during graceful shutdown.
 * Called when the server receives SIGTERM or SIGINT signals.
 * @returns Promise that resolves when all connections are closed
 */
export async function closePool(): Promise<void> {
  await pool.end();
  console.log('Database pool closed');
}
