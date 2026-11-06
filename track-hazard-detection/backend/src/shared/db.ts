/**
 * PostgreSQL pool and transaction helper. PostgreSQL holds the domain event
 * store (the source of truth for every hazard's lifecycle), the edge-event
 * inbox, the transactional outbox, the consumers' processed-event tables and
 * the projections.
 * @module shared/db
 */
import pg from 'pg'
import { config } from './config.js'
import { logger } from './logger.js'

// NUMERIC columns come back as strings by default; mileposts are small, so parse them.
pg.types.setTypeParser(1700, (value) => Number.parseFloat(value))
// BIGINT (global positions, counts) fits comfortably in a JS number at this scale.
pg.types.setTypeParser(20, (value) => Number.parseInt(value, 10))

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.PG_POOL_MAX || 12),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
})

pool.on('error', (err) => {
  logger.error({ err }, 'postgres pool error')
})

export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient
export type Client = pg.PoolClient

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

/** Stable 32-bit key for pg_advisory_xact_lock from a string. */
export function lockKey(name: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h | 0
}
