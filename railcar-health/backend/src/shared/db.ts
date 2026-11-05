/**
 * PostgreSQL pool and transaction helper. PostgreSQL is the source of truth for
 * raw detector passes, resolved bearing readings, alerts, holds, work orders
 * and findings. (Production splits raw readings into a time-series store.)
 * @module shared/db
 */
import pg from 'pg'
import { config } from './config.js'
import { logger } from './logger.js'

// NUMERIC columns come back as strings by default; mileposts and offsets are small, so parse them.
pg.types.setTypeParser(1700, (value) => Number.parseFloat(value))
// BIGINT counts from COUNT(*) fit comfortably in a JS number here.
pg.types.setTypeParser(20, (value) => Number.parseInt(value, 10))

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 3_000,
})

pool.on('error', (err) => {
  logger.error({ err }, 'postgres pool error')
})

export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient

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
