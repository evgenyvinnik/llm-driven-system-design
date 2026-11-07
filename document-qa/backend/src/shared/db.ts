/**
 * PostgreSQL pool and transaction helpers. PostgreSQL is the source of truth
 * for documents, versions, access (scope, groups, tombstones), chunks, the
 * vector index, pipeline jobs and answer runs; RabbitMQ only carries tickets
 * that point back here, and Valkey only holds caches validated against it.
 * @module shared/db
 */
import pg from 'pg'
import { config } from './config.js'
import { logger } from './logger.js'

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

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>, begin = 'BEGIN'): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query(begin)
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

/** A read-only REPEATABLE READ snapshot: every statement inside sees the same committed state. */
export function withSnapshot<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(fn, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
}
