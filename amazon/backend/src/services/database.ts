import pg, { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

const { Pool: PgPool } = pg;

let pool: Pool | null = null;

/** Initializes the PostgreSQL connection pool and verifies connectivity. */
export async function initializeDb(): Promise<Pool> {
  pool = new PgPool({
    connectionString:
      process.env.DATABASE_URL ||
      'postgresql://amazon:amazon_secret@localhost:5432/amazon_ecommerce',
  });

  // Test connection
  const client = await pool.connect();
  const result = await client.query('SELECT NOW()');
  console.log('Database connected:', result.rows[0].now);
  client.release();

  return pool;
}

/** Returns the initialized database pool. Throws if not yet initialized. */
export function getDb(): Pool {
  if (!pool) {
    throw new Error('Database not initialized');
  }
  return pool;
}

/** Executes a parameterized SQL query and logs slow queries in development. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  if (!pool) {
    throw new Error('Database not initialized');
  }
  const start = Date.now();
  const result = await pool.query<T>(text, params);
  const duration = Date.now() - start;
  if (process.env.NODE_ENV === 'development' && duration > 100) {
    console.log('Slow query:', { text, duration, rows: result.rowCount });
  }
  return result;
}

/** Wraps a callback in a database transaction with automatic BEGIN, COMMIT, and ROLLBACK. */
export async function transaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  if (!pool) {
    throw new Error('Database not initialized');
  }
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
