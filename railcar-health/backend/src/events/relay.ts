/**
 * The relay: event store (outbox) -> broker streams.
 *
 * It tails the events table by global_position and publishes each event to its
 * family's stream with the partition key, then advances relay_checkpoint. A
 * NOTIFY from the appending transaction wakes it; a poll is the fallback.
 *
 * At-least-once: a crash after XADD but before the checkpoint update
 * republishes those events on restart; consumers drop them by event id. One
 * relay is active at a time (a session advisory lock); a second instance waits
 * as a hot standby.
 *
 * Production: Debezium (logical decoding) or a Kafka Connect outbox connector
 * does this job, keyed by partition_key so each key keeps its order.
 * @module events/relay
 */
import type { Redis } from 'ioredis'
import pg from 'pg'
import { config } from '../shared/config.js'
import { pool, type Queryable } from '../shared/db.js'
import { logger } from '../shared/logger.js'
import { relayLag, relayPublished } from '../shared/metrics.js'
import { streamKey } from '../shared/stream.js'
import type { StoredEventRow } from './envelope.js'

const RELAY_LOCK = 72_011_002

export async function relayBatch(redis: Redis, db: Queryable = pool, limit = 500): Promise<number> {
  const { rows: cp } = await db.query<{ last_position: number }>('SELECT last_position FROM relay_checkpoint WHERE id = 1')
  const from = Number(cp[0]?.last_position ?? 0)
  const { rows } = await db.query<StoredEventRow>('SELECT * FROM events WHERE global_position > $1 ORDER BY global_position LIMIT $2', [from, limit])
  if (rows.length === 0) {
    relayLag.set(0)
    return 0
  }
  const pipeline = redis.pipeline()
  for (const r of rows) {
    pipeline.xadd(
      streamKey(r.family), 'MAXLEN', '~', String(config.stream.maxLen), '*',
      'event', JSON.stringify(r), 'type', r.type, 'key', r.partition_key, 'pos', String(r.global_position),
    )
  }
  const results = await pipeline.exec()
  const failed = results?.find(([err]) => err)
  if (failed) throw failed[0]
  const last = Number(rows[rows.length - 1].global_position)
  await db.query('UPDATE relay_checkpoint SET last_position = $1, updated_at = now() WHERE id = 1', [last])
  for (const r of rows) relayPublished.inc({ family: r.family })
  return rows.length
}

/** Runs the relay until the returned stop function is called. */
export function startRelay(redis: Redis): () => Promise<void> {
  let stopped = false
  let wake: (() => void) | null = null
  const listener = new pg.Client({ connectionString: config.databaseUrl })
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms)
      wake = () => {
        clearTimeout(t)
        resolve()
      }
    })

  const loop = (async () => {
    await listener.connect()
    listener.on('notification', () => wake?.())
    await listener.query('LISTEN rh_events')
    let leader = false
    while (!stopped) {
      try {
        if (!leader) {
          const { rows } = await listener.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [RELAY_LOCK])
          leader = rows[0].ok
          if (!leader) {
            await sleep(5000)
            continue
          }
          logger.info('relay is the active instance')
        }
        const n = await relayBatch(redis)
        if (n === 500) continue
        await sleep(config.stream.relayPollMs)
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'relay error')
        await sleep(1000)
      }
    }
  })()

  return async () => {
    stopped = true
    wake?.()
    await loop.catch(() => undefined)
    await listener.end().catch(() => undefined)
  }
}
