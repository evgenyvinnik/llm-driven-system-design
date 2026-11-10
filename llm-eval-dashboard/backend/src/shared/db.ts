/**
 * PostgreSQL pool and transaction helper. PostgreSQL is the source of truth
 * for datasets, runs, the task queue, results and scores; there is no
 * separate broker.
 * @module shared/db
 */
import pg from 'pg'
import { config } from './config.js'
import { logger } from './logger.js'

// NUMERIC (scores, temperature) and BIGINT (count(*)) arrive as strings by default.
pg.types.setTypeParser(1700, (v) => Number.parseFloat(v))
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10))

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.PG_POOL_MAX ?? 15),
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
