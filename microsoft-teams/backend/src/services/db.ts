import pg from 'pg';
import { config } from '../config/index.js';
import { logger } from './logger.js';

/** PostgreSQL connection pool for the teams database. */
export const pool = new pg.Pool({
  connectionString: config.database.url,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected pool error');
});

pool.on('connect', () => {
  logger.debug('New database connection established');
});

/**
 * Runs `fn` inside BEGIN/COMMIT on one pooled client, rolling back on any
 * error. Membership changes and message writes span several statements that
 * must land together (or not at all).
 */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
