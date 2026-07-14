import pg, { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import config from '../config/index.js';

const pool: Pool = new pg.Pool({
  host: config.database.host,
  port: config.database.port,
  database: config.database.database,
  user: config.database.user,
  password: config.database.password,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err: Error) => {
  console.error('Unexpected error on idle database client', err);
  process.exit(-1);
});

/** Executes a parameterized SQL query against the connection pool. */
export const query = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> => pool.query<T>(text, params);

/** Acquires a dedicated client from the connection pool for transaction use. */
export const getClient = (): Promise<PoolClient> => pool.connect();

export { pool };
export default pool;
