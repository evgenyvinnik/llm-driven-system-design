import pg, { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

// BIGINT columns (messages.seq, conversations.last_seq) arrive as strings by
// default to avoid precision loss. Sequence numbers stay far below 2^53, so
// parse them as numbers once here instead of at every call site.
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => parseInt(value, 10));

const pool: Pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://imessage:imessage_secret@localhost:5432/imessage',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err: Error) => {
  console.error('Unexpected error on idle client', err);
});

/** Executes a parameterized SQL query with development-mode duration logging. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const start = Date.now();
  const result = await pool.query<T>(text, params);
  const duration = Date.now() - start;
  if (process.env.NODE_ENV === 'development') {
    console.log('Executed query', { text: text.slice(0, 50), duration, rows: result.rowCount });
  }
  return result;
}

/** Acquires a dedicated client from the connection pool for manual query execution. */
export async function getClient(): Promise<PoolClient> {
  return await pool.connect();
}

/** Executes a callback within a database transaction with automatic commit/rollback. */
export async function transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export default pool;
