/**
 * PostgreSQL pool and transaction helper. PostgreSQL is the source of truth
 * for runs, the job graph, the claim queue, leases and the audit trail; there
 * is no separate broker.
 * @module shared/db
 */
import pg from 'pg'
import { config } from './config.js'
import { logger } from './logger.js'

// BIGINT arrives as a string by default. Fencing tokens and line numbers stay well inside 2^53 here.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10))

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.PG_POOL_MAX ?? 20),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
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
