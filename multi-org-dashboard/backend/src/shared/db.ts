/**
 * PostgreSQL pool and transaction helper. PostgreSQL is the source of truth for
 * memberships, roles, flags, resources, audit events and export jobs.
 * @module shared/db
 */
import pg from 'pg'
import { config } from './config.js'
import { logger } from './logger.js'

// BIGINT counters (authz_version, row counts) fit comfortably in a JS number.
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
