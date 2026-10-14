import pg from 'pg';

const { Pool } = pg;

/**
 * PostgreSQL connection pool for the news aggregator database.
 * Provides connection pooling for efficient database access across the application.
 * Configured with sensible defaults for connection management.
 */
export const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'newsagg',
  password: process.env.DB_PASSWORD || 'newsagg_dev',
  database: process.env.DB_NAME || 'news_aggregator',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

/**
 * Execute a SQL query and return all matching rows.
 * Used for SELECT queries that return multiple records.
 * @param text - The SQL query string with optional $1, $2, etc. placeholders
 * @param params - Array of values to substitute for placeholders
 * @returns Array of rows matching the query, typed as T
 */
export async function query<T>(text: string, params?: unknown[]): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

/**
 * Execute a SQL query and return the first matching row.
 * Useful for queries expected to return a single record (e.g., lookup by ID).
 * @param text - The SQL query string with optional $1, $2, etc. placeholders
 * @param params - Array of values to substitute for placeholders
 * @returns The first matching row typed as T, or null if no rows found
 */
export async function queryOne<T>(text: string, params?: unknown[]): Promise<T | null> {
  const result = await pool.query(text, params);
  return (result.rows[0] as T) || null;
}

/**
 * Execute a SQL statement and return the number of affected rows.
 * Used for INSERT, UPDATE, and DELETE operations where row count matters.
 * @param text - The SQL statement with optional $1, $2, etc. placeholders
 * @param params - Array of values to substitute for placeholders
 * @returns The number of rows affected by the operation
 */
export async function execute(text: string, params?: unknown[]): Promise<number> {
  const result = await pool.query(text, params);
  return result.rowCount || 0;
}

/**
 * Run a function inside a single database transaction.
 * Commits when the function resolves, rolls back when it throws, and always
 * releases the client back to the pool. Use it for multi-statement writes that
 * must succeed or fail together (an article and its story assignment, a user
 * and their preferences row).
 * @param fn - Work to run with the transaction's dedicated client
 * @returns Whatever the function returns
 */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
