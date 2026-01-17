import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

/**
 * PostgreSQL connection pool for the price tracking database.
 * Provides connection pooling to efficiently manage database connections
 * across multiple concurrent requests in the API and scraper services.
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://pricetracker:pricetracker123@localhost:5432/pricetracker',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

export default pool;

/**
 * Executes a SQL query and returns typed results.
 * Uses connection pooling to ensure efficient database access across the application.
 * @param text - The SQL query string with optional parameter placeholders ($1, $2, etc.)
 * @param params - Optional array of parameter values to substitute in the query
 * @returns Array of typed result rows
 */
export async function query<T>(text: string, params?: unknown[]): Promise<T[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result.rows as T[];
  } finally {
    client.release();
  }
}

/**
 * Executes a SQL query expecting a single row result.
 * Useful for lookups by ID or unique constraints.
 * @param text - The SQL query string with optional parameter placeholders
 * @param params - Optional array of parameter values to substitute in the query
 * @returns The first result row or null if no rows returned
 */
export async function queryOne<T>(text: string, params?: unknown[]): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] || null;
}

/**
 * Executes multiple database operations within a single transaction.
 * Ensures atomicity for operations like creating products with subscriptions,
 * or updating prices while recording history.
 * @param callback - Async function receiving a query executor to run within the transaction
 * @returns The result of the callback function
 */
export async function transaction<T>(
  callback: (client: { query: (text: string, params?: unknown[]) => Promise<unknown[]> }) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback({
      query: async (text: string, params?: unknown[]) => {
        const res = await client.query(text, params);
        return res.rows;
      },
    });
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
