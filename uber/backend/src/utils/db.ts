import pg, { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import config from '../config/index.js';

const pool: Pool = new pg.Pool({
  connectionString: config.database.url,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err: Error): void => {
  console.error('Unexpected database error:', err);
});

export const query = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> => pool.query<T>(text, params);

export const getClient = (): Promise<PoolClient> => pool.connect();

export default pool;
