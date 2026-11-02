import pg from 'pg';
import { config } from '../config/index.js';
import { logger } from './logger.js';

/**
 * BIGINT (int8) columns come back from pg as strings by default, because int8
 * can exceed Number.MAX_SAFE_INTEGER. Here they hold integer cents and
 * COUNT(*) results, both far below 2^53, so parse them to numbers. Left as
 * strings, `sum + o.amount_cents` in the kanban column total concatenated
 * ("0" + "22000000" + "54000000") instead of adding, and the API contradicted
 * its own `amount_cents: number` type.
 */
export function parseInt8(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`int8 value ${value} exceeds the safe integer range`);
  }
  return n;
}

/**
 * DATE columns are calendar days with no time zone. pg's default turns them
 * into a JS Date at local midnight, which JSON-serializes as a UTC timestamp
 * and shifts the day for anyone west of the server. Keep the 'YYYY-MM-DD' text.
 */
export function parseDate(value: string): string {
  return value;
}

pg.types.setTypeParser(pg.types.builtins.INT8, parseInt8);
pg.types.setTypeParser(pg.types.builtins.DATE, parseDate);

/** PostgreSQL connection pool configured with connection limits and timeout settings. */
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
