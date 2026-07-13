import pg, { QueryResult, PoolClient } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://tiktok:tiktok_secret@localhost:5432/tiktok',
});

pool.on('error', (err: Error) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

/** Executes a parameterized SQL query against the connection pool. */
export const query = (text: string, params?: unknown[]): Promise<QueryResult> =>
  pool.query(text, params);

/** Acquires a client from the pool for manual transaction control. */
export const getClient = (): Promise<PoolClient> => pool.connect();

export default pool;
