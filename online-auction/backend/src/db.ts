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

/** Executes a parameterized SQL query against the connection pool. */
export const query = (text: string, params?: unknown[]): Promise<QueryResult> =>
  pool.query(text, params);

/** Acquires a client from the pool for manual transaction control. */
export const getClient = (): Promise<PoolClient> => pool.connect();

/**
 * Runs `fn` inside BEGIN/COMMIT on one pooled connection and rolls back if it
 * throws. Every multi-statement write (a bid, a close, a cancel) goes through
 * this so a failure can never leave half of it applied.
 */
export const withTransaction = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

export default pool;
