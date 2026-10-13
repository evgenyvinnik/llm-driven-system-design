/**
 * PostgreSQL database connection pool
 * @module shared/db
 */
import pg, { QueryResultRow } from 'pg'

const { Pool, types } = pg

// BIGINT (OID 20) arrives as a string by default. Sync sequence numbers and COUNT(*) results
// stay far below 2^53, so parse them as numbers instead of leaking strings into the API.
types.setTypeParser(20, (value) => parseInt(value, 10))

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

/** Transaction options; the default is PostgreSQL's READ COMMITTED read-write transaction. */
export interface TransactionOptions {
  /** Use REPEATABLE READ READ ONLY when several statements must see one snapshot. */
  snapshot?: boolean
}

/** Runs a function within a database transaction with automatic commit/rollback. */
export async function transaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  options: TransactionOptions = {}
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query(options.snapshot ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN')
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
