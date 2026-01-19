import pg, { QueryResult, PoolClient } from 'pg';
const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'auction_db',
  user: process.env.DB_USER || 'auction',
  password: process.env.DB_PASSWORD || 'auction123',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err: Error) => {
  console.error('Unexpected error on idle client', err);
});

export const query = (text: string, params?: unknown[]): Promise<QueryResult> =>
  pool.query(text, params);

export const getClient = (): Promise<PoolClient> => pool.connect();

export default pool;
