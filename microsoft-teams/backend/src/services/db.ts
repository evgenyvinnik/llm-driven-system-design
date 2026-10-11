import pg from 'pg';
import { config } from '../config/index.js';
import { logger } from './logger.js';

// BIGINT columns (channel sequence numbers, file sizes) arrive as strings by default. Values here
// stay far below 2^53, so parse them as plain numbers and keep JSON payloads numeric.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number.parseInt(value, 10));

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
 * Returned from a transaction callback to roll back instead of committing while still producing
 * a result. Used when a write turns out to be a no-op (duplicate send, reaction already present):
 * rolling back hands the channel sequence number the transaction took back to the counter.
 */
export class RollbackWith<T> {
  constructor(readonly value: T) {}
}

/** Runs `work` inside a transaction on a dedicated client, rolling back on any error. */
export async function withTransaction<T>(
  work: (client: pg.PoolClient) => Promise<T | RollbackWith<T>>,
  begin = 'BEGIN',
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(begin);
    const result = await work(client);
    if (result instanceof RollbackWith) {
      await client.query('ROLLBACK');
      return result.value;
    }
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
