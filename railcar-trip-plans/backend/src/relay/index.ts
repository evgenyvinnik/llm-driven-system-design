/**
 * Outbox relay: publishes committed events from the event store to their topic partition streams.
 *
 * Loop: lock the oldest unpublished rows (FOR UPDATE SKIP LOCKED), XADD each to `tp:<topic>:<partition>`
 * (the partition is the hash of the event's key), mark them published, commit. A crash after XADD and
 * before commit publishes those rows again on restart: consumers see a duplicate and drop it by event id.
 * Rows are taken in position order, and a stream's rows are appended under a per-stream lock, so one key's
 * events reach its partition in the order they were appended.
 *
 * One relay runs at a time (a session advisory lock), because two relays could interleave one key's
 * events. It wakes on LISTEN tp_events and also polls, so a missed notification only costs latency.
 * Health, metrics and the outbox backlog gauge are on RELAY_PORT.
 */
import type { EventRow } from '../shared/events/envelope.js'
process.env.SERVICE_NAME ??= 'relay'
const express = (await import('express')).default
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { redis } = await import('../shared/cache.js')
const { toWire } = await import('../shared/events/envelope.js')
const { streamFor } = await import('../shared/streams.js')
const { eventsPublished, metricsHandler, outboxBacklog } = await import('../shared/metrics.js')
const { EVENT_COLUMNS } = await import('../shared/event-store.js')
type Row = EventRow

let running = true
let wake: (() => void) | null = null
let published = 0

const listener = await pool.connect()
const { rows: lockRows } = await listener.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtext('tp-relay')) AS ok")
if (!lockRows[0].ok) {
  logger.error('another relay holds the relay lock; exiting')
  listener.release()
  await pool.end()
  process.exit(1)
}
await listener.query('LISTEN tp_events')
listener.on('notification', () => wake?.())

async function publishBatch(): Promise<number> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query<Row>(
      `SELECT ${EVENT_COLUMNS} FROM events WHERE published_at IS NULL ORDER BY position LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [config.relay.batch],
    )
    if (rows.length === 0) {
      await client.query('COMMIT')
      return 0
    }
    const pipeline = redis.pipeline()
    for (const row of rows) {
      pipeline.xadd(streamFor(row.topic, row.partition_key), 'MAXLEN', '~', String(config.streams.maxLen), '*', 'id', row.event_id, 'type', row.type, 'key', row.partition_key, 'e', toWire(row))
    }
    const results = await pipeline.exec()
    const failed = results?.find(([err]) => err)
    if (failed) throw failed[0]
    await client.query('UPDATE events SET published_at = now() WHERE position = ANY($1)', [rows.map((r) => r.position)])
    await client.query('COMMIT')
    for (const row of rows) eventsPublished.inc({ topic: row.topic })
    published += rows.length
    return rows.length
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}

async function loop(): Promise<void> {
  while (running) {
    try {
      const n = await publishBatch()
      if (n === config.relay.batch) continue
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'relay publish failed; retrying')
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.max(config.relay.idleMs, 250))
      wake = () => {
        clearTimeout(timer)
        resolve()
      }
    })
    wake = null
  }
}

const backlogTimer = setInterval(() => {
  pool
    .query<{ n: number }>('SELECT COUNT(*)::int AS n FROM events WHERE published_at IS NULL')
    .then(({ rows }) => outboxBacklog.set(rows[0].n))
    .catch(() => undefined)
}, 2_000)

const app = express()
app.get('/health', (_req, res) => res.json({ status: 'ok', published }))
app.get('/metrics', metricsHandler)
const server = app.listen(config.ports.relay, () => logger.info({ port: config.ports.relay }, 'relay started'))
const done = loop()

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  running = false
  wake?.()
  clearInterval(backlogTimer)
  await done.catch(() => undefined)
  server.close()
  listener.release()
  await Promise.allSettled([pool.end(), redis.quit()])
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
