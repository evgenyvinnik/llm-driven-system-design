/**
 * PostgreSQL database connection pool
 * @module shared/db
 */
import pg, { QueryResultRow } from 'pg'

const { Pool } = pg

/** PostgreSQL connection pool */
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/highlights',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
})

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err)
})

/**
 * Execute a database query
 * @param text - SQL query string
 * @param params - Query parameters
 * @returns Query result
 */
/** Executes a parameterized SQL query against the PostgreSQL pool. */
export async function query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<pg.QueryResult<T>> {
  const start = Date.now()
  const result = await pool.query<T>(text, params)
  const duration = Date.now() - start
  if (duration > 100) {
    console.log('Slow query:', { text: text.slice(0, 100), duration, rows: result.rowCount })
  }
  return result
}

/**
 * Execute a transaction with automatic commit/rollback
 * @param fn - Function receiving the client
 * @returns Transaction result
 */
/** Runs a function within a database transaction with automatic commit/rollback. */
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
