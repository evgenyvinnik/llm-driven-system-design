/**
 * The outbox relay. Publishes committed outbox rows to Valkey Streams in
 * priority order: critical edge events and domain events are drained before
 * trains and bulk readings, and the loop goes back to the top after every
 * batch, so a 3,000-event reconnect backlog never sits in front of a new
 * critical event.
 *
 * Delivery is at-least-once: if the process dies after XADD but before the
 * UPDATE commits, the rows are published again and consumers dedupe by event id.
 * Within a lane, rows are published in id order (commit order per partition
 * key), so per-segment order is preserved. One relay is leader at a time.
 * @module relay/relay
 */
import type { Redis } from 'ioredis'
import pg from 'pg'
import { config } from '../shared/config.js'
import { pool } from '../shared/db.js'
import type { Topic } from '../shared/event-store.js'
import { logger } from '../shared/logger.js'
import { outboxBacklog, outboxPublished } from '../shared/metrics.js'
import { partitionFor, streamKey } from '../shared/streams.js'

export const LANE_PRIORITY = ['critical', 'domain', 'trains', 'bulk'] as const

interface OutboxRow {
  id: number
  event_id: string
  topic: Topic
  lane: string
  partition_key: string
  envelope: { type: string }
}

/** Publishes up to `limit` unpublished rows of one lane. Returns how many were published. */
export async function publishLane(redis: Redis, lane: string, limit: number): Promise<number> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query<OutboxRow>(
      'SELECT id, event_id, topic, lane, partition_key, envelope FROM outbox WHERE published_at IS NULL AND lane = $1 ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED',
      [lane, limit],
    )
    if (rows.length === 0) {
      await client.query('COMMIT')
      return 0
    }
    const pipeline = redis.pipeline()
    for (const r of rows) {
      const key = streamKey(r.topic, partitionFor(r.partition_key))
      pipeline.xadd(key, 'MAXLEN', '~', String(config.streams.maxLen), '*', 'event', JSON.stringify(r.envelope), 'eventId', r.event_id, 'type', r.envelope.type)
    }
    const results = await pipeline.exec()
    const failed = results?.find(([err]) => err)
    if (failed) throw failed[0]
    await client.query('UPDATE outbox SET published_at = clock_timestamp() WHERE id = ANY($1::bigint[])', [rows.map((r) => r.id)])
    await client.query('COMMIT')
    outboxPublished.inc({ lane }, rows.length)
    return rows.length
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}

/** One pass in priority order. Restarts from the top whenever critical or domain rows were found. */
export async function relayPass(redis: Redis): Promise<number> {
  let total = 0
  for (;;) {
    const urgent = (await publishLane(redis, 'critical', config.relay.batch)) + (await publishLane(redis, 'domain', config.relay.batch))
    total += urgent
    if (urgent > 0) continue
    const rest = (await publishLane(redis, 'trains', config.relay.batch)) + (await publishLane(redis, 'bulk', config.relay.batch))
    total += rest
    if (rest === 0) return total
  }
}

export async function updateBacklogGauge(): Promise<void> {
  const { rows } = await pool.query<{ lane: string; n: number }>('SELECT lane, count(*)::int AS n FROM outbox WHERE published_at IS NULL GROUP BY lane')
  for (const lane of LANE_PRIORITY) outboxBacklog.set({ lane }, rows.find((r) => r.lane === lane)?.n ?? 0)
}

export async function pruneOutbox(): Promise<void> {
  await pool.query(`DELETE FROM outbox WHERE published_at < now() - interval '1 hour'`)
}

/** LISTEN outbox: the ingest and append transactions NOTIFY at commit, so the relay wakes in milliseconds. */
export async function listenForOutbox(onNotify: () => void): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: config.databaseUrl })
  await client.connect()
  client.on('notification', () => onNotify())
  client.on('error', (err) => logger.warn({ err: err.message }, 'outbox listener error'))
  await client.query('LISTEN outbox')
  return client
}
