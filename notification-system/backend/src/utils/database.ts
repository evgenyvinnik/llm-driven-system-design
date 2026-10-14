import pg, { QueryResult, QueryResultRow } from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  user: process.env.POSTGRES_USER || 'notification_user',
  password: process.env.POSTGRES_PASSWORD || 'notification_password',
  database: process.env.POSTGRES_DB || 'notification_db',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

/** Verifies PostgreSQL connectivity by executing a test query. */
export async function initDatabase(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}

/** Executes a parameterized SQL query with slow-query logging. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const start = Date.now();
  const result = await pool.query<T>(text, params);
  const duration = Date.now() - start;
  if (duration > 100) {
    console.log('Slow query:', { text, duration, rows: result.rowCount });
  }
  return result;
}

/**
 * Runs `fn` inside a single transaction on one pooled client. Commits when `fn`
 * resolves, rolls back when it throws. Used wherever several rows must change
 * together (notification + deliveries + outbox, delivery status + aggregate).
 */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
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
}
