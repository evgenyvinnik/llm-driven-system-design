/**
 * PostgreSQL pool and transaction helper. PostgreSQL holds the event store (the source of truth and the
 * outbox), the log indexes, and every consumer's read model and idempotency markers.
 * @module shared/db
 */
import pg from 'pg'
import { config } from './config.js'
import { logger } from './logger.js'

// BIGINT (positions, counts) fit comfortably in a JS number here.
pg.types.setTypeParser(20, (value) => Number.parseInt(value, 10))
pg.types.setTypeParser(1700, (value) => Number.parseFloat(value))

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: Number.parseInt(process.env.PG_POOL_MAX || '10', 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
})

pool.on('error', (err) => {
  logger.error({ err }, 'postgres pool error')
})

export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient
export type Tx = pg.PoolClient

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}
