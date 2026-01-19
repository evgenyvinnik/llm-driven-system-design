import pg, { PoolClient, QueryResult } from 'pg';
import { config } from '../config/index.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: config.database.url,
});

pool.on('error', (err: Error) => {
  console.error('Unexpected error on idle client', err);
});

export const query = async <T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> => {
  const start = Date.now();
  const res = await pool.query<T>(text, params);
  const duration = Date.now() - start;
  if (config.nodeEnv === 'development') {
    console.log('Executed query', { text: text.substring(0, 50), duration, rows: res.rowCount });
  }
  return res;
};

export const getClient = async (): Promise<PoolClient> => {
  return await pool.connect();
};

export const end = async (): Promise<void> => {
  await pool.end();
};

export const db = {
  query,
  getClient,
  pool,
  end,
};
