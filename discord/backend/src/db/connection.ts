import pg from 'pg';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgresql://discord:discord@localhost:5432/babydiscord',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  logger.error('Unexpected error on idle database client', err);
});

pool.on('connect', () => {
  logger.debug('New database connection established');
});

export const db = {
  query: <T extends pg.QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<pg.QueryResult<T>> => {
    return pool.query<T>(text, params);
  },

  getClient: async () => {
    const client = await pool.connect();
    return client;
  },

  async healthCheck(): Promise<boolean> {
    try {
      await pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  },

  async close(): Promise<void> {
    await pool.end();
  },
};

export default db;
