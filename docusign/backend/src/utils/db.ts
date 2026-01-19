import pg, { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

const { Pool: PgPool } = pg;

export const pool: Pool = new PgPool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  database: process.env.POSTGRES_DB || 'docusign',
  user: process.env.POSTGRES_USER || 'docusign',
  password: process.env.POSTGRES_PASSWORD || 'docusign_dev',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

export async function initializeDatabase(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}

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

export async function getClient(): Promise<PoolClient> {
  return await pool.connect();
}
