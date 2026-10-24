/**
 * PostgreSQL pools and a transaction helper that retries deadlocks.
 * @module shared/db
 */
import pg from 'pg'
import { logger } from './logger.js'
import { txRetries } from './metrics.js'

// BIGINT (int8) comes back as a string by default. Sizes and capacities stay far
// below 2^53, so parse them as numbers once, here, instead of at every call site.
pg.types.setTypeParser(20, (value) => Number(value))

export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 20, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 3_000 })
  pool.on('error', (err) => logger.error({ err }, 'postgres pool error'))
  return pool
}

/** 40P01 deadlock_detected, 40001 serialization_failure. */
const RETRYABLE = new Set(['40P01', '40001'])

/**
 * Runs `fn` in a READ COMMITTED transaction. If PostgreSQL aborts it to break a
 * deadlock, the whole transaction is retried from the start. The hot path takes
 * locks in one order so this is rare; merge and restore rely on it.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  operation: string,
  fn: (client: pg.PoolClient) => Promise<T>,
  attempts = 4,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined)
      const code = (err as { code?: string }).code
      if (code && RETRYABLE.has(code) && attempt < attempts) {
        txRetries.inc({ operation })
        logger.warn({ operation, attempt, code }, 'retrying transaction')
        await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt * Math.random()))
        continue
      }
      throw err
    } finally {
      client.release()
    }
  }
}
