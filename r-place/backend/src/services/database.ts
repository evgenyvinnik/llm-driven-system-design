/**
 * PostgreSQL database connection and query utilities.
 *
 * Provides a connection pool for efficient database access and
 * helper functions for common query patterns.
 */
import { Pool } from 'pg';
import { logger } from '../shared/logger.js';
import { postgresQueriesTotal, postgresQueryDuration } from '../shared/metrics.js';

/**
 * PostgreSQL connection pool.
 * Configured with sensible defaults for a development environment.
 * Manages up to 20 concurrent connections with automatic cleanup.
 */
export const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  user: process.env.POSTGRES_USER || 'rplace',
  password: process.env.POSTGRES_PASSWORD || 'rplace_dev',
  database: process.env.POSTGRES_DB || 'rplace',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  logger.error({ error: err }, 'Unexpected PostgreSQL pool error');
});

pool.on('connect', () => {
  logger.debug('PostgreSQL pool connection established');
});

pool.on('acquire', () => {
  logger.trace('PostgreSQL client acquired from pool');
});

pool.on('release', () => {
  logger.trace('PostgreSQL client released to pool');
});

/**
 * Classifies a query for metrics based on the SQL command.
 *
 * @param text - The SQL query string.
 * @returns The query type for metrics labeling.
 */
function classifyQuery(text: string): string {
  const trimmed = text.trim().toUpperCase();
  if (trimmed.startsWith('SELECT')) return 'select';
  if (trimmed.startsWith('INSERT')) return 'insert';
  if (trimmed.startsWith('UPDATE')) return 'update';
  if (trimmed.startsWith('DELETE')) return 'delete';
  return 'other';
}

/**
 * Executes a SQL query and returns all matching rows.
 *
 * @template T - The expected shape of each returned row.
 * @param text - The SQL query string with $1, $2, etc. placeholders.
 * @param params - Optional array of parameter values for the placeholders.
 * @returns Promise resolving to an array of typed rows.
 */
export async function query<T>(text: string, params?: unknown[]): Promise<T[]> {
  const start = Date.now();
  const queryType = classifyQuery(text);

  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;

    postgresQueriesTotal.inc({ query_type: queryType, status: 'success' });
    postgresQueryDuration.observe({ query_type: queryType }, duration / 1000);

    // Log slow queries
    if (duration > 100) {
      logger.warn(
        { queryType, durationMs: duration, rowCount: result.rowCount },
        'Slow PostgreSQL query detected'
      );
    }

    return result.rows as T[];
  } catch (error) {
    const duration = Date.now() - start;
    postgresQueriesTotal.inc({ query_type: queryType, status: 'error' });
    postgresQueryDuration.observe({ query_type: queryType }, duration / 1000);

    logger.error(
      { error, queryType, durationMs: duration },
      'PostgreSQL query error'
    );
    throw error;
  }
}

/**
 * Executes a SQL query and returns the first matching row.
 * Useful for queries expected to return at most one result.
 *
 * @template T - The expected shape of the returned row.
 * @param text - The SQL query string with $1, $2, etc. placeholders.
 * @param params - Optional array of parameter values for the placeholders.
 * @returns Promise resolving to a single typed row or null if not found.
 */
export async function queryOne<T>(text: string, params?: unknown[]): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] || null;
}

/**
 * Checks if the PostgreSQL connection is healthy.
 *
 * @returns Promise that resolves to true if PostgreSQL is connected, false otherwise.
 */
export async function isPostgresHealthy(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Gracefully closes the PostgreSQL connection pool.
 */
export async function closePool(): Promise<void> {
  await pool.end();
  logger.info('PostgreSQL pool closed');
}
