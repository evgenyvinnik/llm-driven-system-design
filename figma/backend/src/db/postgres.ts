import { Pool, PoolClient } from 'pg';
import { logger, dbLatencyHistogram } from '../shared/index.js';

/**
 * PostgreSQL connection pool for the Figma clone application.
 * Manages connections to the database for file metadata, versions, and operations storage.
 * Uses environment variables for configuration with sensible defaults for local development.
 */
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'figma',
  password: process.env.DB_PASSWORD || 'figma_password',
  database: process.env.DB_NAME || 'figma_db',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

/**
 * Determines the query type from SQL for metrics labeling.
 * @param sql - The SQL query string
 * @returns Query type label
 */
function getQueryType(sql: string): string {
  const trimmed = sql.trim().toUpperCase();
  if (trimmed.startsWith('SELECT')) return 'select';
  if (trimmed.startsWith('INSERT')) return 'insert';
  if (trimmed.startsWith('UPDATE')) return 'update';
  if (trimmed.startsWith('DELETE')) return 'delete';
  if (trimmed.startsWith('CREATE') || trimmed.startsWith('ALTER') || trimmed.startsWith('DROP')) return 'ddl';
  return 'other';
}

/**
 * Executes a SQL query and returns all matching rows.
 * Used for fetching multiple records like file lists or version history.
 * @param text - The SQL query string with optional $1, $2, etc. placeholders
 * @param params - Optional array of values to substitute into the query placeholders
 * @returns Promise resolving to an array of typed rows
 */
export async function query<T>(text: string, params?: unknown[]): Promise<T[]> {
  const start = Date.now();
  const queryType = getQueryType(text);

  try {
    const result = await pool.query(text, params);
    const duration = (Date.now() - start) / 1000;

    dbLatencyHistogram.observe({ query_type: queryType }, duration);
    logger.debug({ queryType, duration, rows: result.rowCount }, 'Query executed');

    return result.rows as T[];
  } catch (error) {
    logger.error({ queryType, error, query: text.substring(0, 100) }, 'Query failed');
    throw error;
  }
}

/**
 * Executes a SQL query and returns the first row or null.
 * Used for fetching single records like a specific file or version.
 * @param text - The SQL query string with optional $1, $2, etc. placeholders
 * @param params - Optional array of values to substitute into the query placeholders
 * @returns Promise resolving to a single typed row or null if not found
 */
export async function queryOne<T>(text: string, params?: unknown[]): Promise<T | null> {
  const start = Date.now();
  const queryType = getQueryType(text);

  try {
    const result = await pool.query(text, params);
    const duration = (Date.now() - start) / 1000;

    dbLatencyHistogram.observe({ query_type: queryType }, duration);
    logger.debug({ queryType, duration, found: result.rows.length > 0 }, 'Query executed');

    return (result.rows[0] as T) || null;
  } catch (error) {
    logger.error({ queryType, error, query: text.substring(0, 100) }, 'Query failed');
    throw error;
  }
}

/**
 * Executes a SQL command that modifies data (INSERT, UPDATE, DELETE).
 * Used for creating, updating, or deleting files, versions, and operations.
 * @param text - The SQL command string with optional $1, $2, etc. placeholders
 * @param params - Optional array of values to substitute into the command placeholders
 * @returns Promise resolving to the number of affected rows
 */
export async function execute(text: string, params?: unknown[]): Promise<number> {
  const start = Date.now();
  const queryType = getQueryType(text);

  try {
    const result = await pool.query(text, params);
    const duration = (Date.now() - start) / 1000;

    dbLatencyHistogram.observe({ query_type: queryType }, duration);
    logger.debug({ queryType, duration, rowCount: result.rowCount }, 'Command executed');

    return result.rowCount || 0;
  } catch (error) {
    logger.error({ queryType, error, query: text.substring(0, 100) }, 'Command failed');
    throw error;
  }
}

/**
 * Executes a function within a database transaction.
 * Automatically commits on success and rolls back on error.
 * @param fn - Function to execute within the transaction
 * @returns Promise resolving to the function's return value
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  const start = Date.now();

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');

    logger.debug({ duration: Date.now() - start }, 'Transaction committed');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error({ duration: Date.now() - start, error }, 'Transaction rolled back');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Tests the database connection by executing a simple query.
 * Called during server startup to verify PostgreSQL is accessible.
 * @returns Promise resolving to true if connection is successful, false otherwise
 */
export async function testConnection(): Promise<boolean> {
  try {
    await pool.query('SELECT NOW()');
    logger.info('PostgreSQL connected successfully');
    return true;
  } catch (error) {
    logger.error({ error }, 'PostgreSQL connection failed');
    return false;
  }
}

/**
 * Gets pool statistics for monitoring.
 * @returns Pool statistics object
 */
export function getPoolStats() {
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  };
}

export default pool;
