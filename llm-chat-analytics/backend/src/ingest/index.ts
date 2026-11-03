/**
 * Ingest service: consumes chat-events from Kafka and writes deduplicated rows
 * to ClickHouse, whose materialized views update the rollups.
 *
 * Per chunk of one partition's messages, the order of effects is what makes
 * this safe under crashes and retries:
 *   1. claim each event_id in Valkey (duplicates from other messages drop out)
 *   2. insert the rows with an insert_deduplication_token derived from the
 *      partition and offset range (a retried insert of the same chunk is a no-op)
 *   3. record the partition's inserted-through offset
 *   4. commit the Kafka offset
 * A crash after 2 but before 4 redelivers the chunk; step 3 skips it. A crash
 * between 2 and 3 is covered by the token, as long as the next owner rebuilds
 * exactly the same chunk: Kafka may redeliver more messages than before, so
 * the offset range is recorded as in flight before the insert, and the first
 * chunk after a restart is cut at that range.
 */
import express from 'express'
import type { EachBatchPayload } from 'kafkajs'
import { keys, redis } from '../shared/cache.js'
import { clickhouse, ensureClickHouseSchema } from '../shared/clickhouse.js'
import { config } from '../shared/config.js'
import { streamOf, type EventType } from '../shared/contract.js'
import { pool } from '../shared/db.js'
import { ensureTopic, kafka } from '../shared/kafka.js'
import { childLogger } from '../shared/logger.js'
import { eventsDropped, eventsIngested, ingestBatchSeconds, metricsHandler, watermarkLagSeconds } from '../shared/metrics.js'
import { getOrgs, getPrices, refreshReference } from '../shared/reference.js'
import { computeWatermarks, type PartitionPosition, type Watermarks } from '../shared/watermark.js'
import { processBatch, RedisDedupStore, type BatchMessage } from './pipeline.js'

const log = childLogger('ingest')
const CHUNK = 2000
const dedup = new RedisDedupStore(redis)

let watermarks: Watermarks = { client: null, server: null }
const assigned = new Set<number>()
/** Next offset to process per partition, and the latest received_time processed. */
const nextOffset = new Map<number, number>()
const lastReceived = new Map<number, number>()

async function insertedThrough(partition: number): Promise<number> {
  const v = await redis.hget(keys.insertedThrough, String(partition))
  return v === null ? -1 : Number(v)
}

async function insertWithRetry(table: string, values: unknown[], token: string | undefined): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await clickhouse.insert({
        table,
        values,
        format: 'JSONEachRow',
        clickhouse_settings: token
          ? { insert_deduplication_token: token, deduplicate_blocks_in_dependent_materialized_views: 1 }
          : {},
      })
      return
    } catch (err) {
      if (attempt >= 5) throw err
      log.warn({ err: (err as Error).message, attempt, table }, 'insert failed, retrying with the same token')
      await new Promise((r) => setTimeout(r, 200 * 2 ** attempt))
    }
  }
}

async function handleChunk(partition: number, messages: BatchMessage[]): Promise<void> {
  const end = ingestBatchSeconds.startTimer()
  const result = await processBatch(messages, {
    dedup,
    insertedThrough: await insertedThrough(partition),
    ctx: { orgs: getOrgs(), prices: getPrices(), watermarks },
    keyFor: keys.dedup,
  })

  if (result.rows.length > 0) {
    await redis.hset(keys.inflight, String(partition), `${result.firstOffset}-${result.lastOffset}`)
    const token = `p${partition}-${result.firstOffset}-${result.lastOffset}`
    await insertWithRetry('events', result.rows, token)
  }
  if (result.rejected.length > 0) {
    await insertWithRetry('rejected_events', result.rejected, undefined)
  }

  const tx = redis.multi()
  tx.hset(keys.insertedThrough, String(partition), String(result.lastOffset))
  tx.hdel(keys.inflight, String(partition))
  tx.hincrby(keys.counters, 'accepted', result.rows.length)
  tx.hincrby(keys.counters, 'duplicates', result.duplicates)
  tx.hincrby(keys.counters, 'late', result.late)
  tx.hincrby(keys.counters, 'already_inserted', result.alreadyInserted)
  for (const r of result.rejected) tx.hincrby(keys.counters, `rejected:${r.reason}`, 1)
  // Late rows changed buckets the dashboard had called complete: bump those days' revisions so cached windows covering them go stale.
  for (const [org, days] of result.lateDays) for (const day of days) tx.hincrby(keys.revision(org), day, 1)
  await tx.exec()

  for (const row of result.rows) eventsIngested.inc({ stream: streamOf(row.event_type as EventType), late: String(row.is_late) })
  if (result.duplicates) eventsDropped.inc({ reason: 'duplicate' }, result.duplicates)
  if (result.alreadyInserted) eventsDropped.inc({ reason: 'already_inserted' }, result.alreadyInserted)
  for (const r of result.rejected) eventsDropped.inc({ reason: r.reason })

  nextOffset.set(partition, result.lastOffset + 1)
  if (result.maxReceivedAt !== null) {
    lastReceived.set(partition, Math.max(lastReceived.get(partition) ?? 0, result.maxReceivedAt))
  }
  end()
  if (result.duplicates || result.late || result.rejected.length) {
    log.info(
      { partition, rows: result.rows.length, duplicates: result.duplicates, late: result.late, rejected: result.rejected.length },
      'chunk ingested',
    )
  }
}

async function eachBatch({ batch, heartbeat, isRunning, isStale, resolveOffset, commitOffsetsIfNecessary }: EachBatchPayload) {
  const partition = batch.partition
  const messages = batch.messages
  const inflight = await redis.hget(keys.inflight, String(partition))
  let i = 0
  while (i < messages.length) {
    if (!isRunning() || isStale()) return
    let end = Math.min(i + CHUNK, messages.length)
    if (i === 0 && inflight) {
      const [first, last] = inflight.split('-').map(Number)
      if (Number(messages[0].offset) === first) {
        // The previous owner died mid-insert on this exact range: rebuild the same chunk so its token matches.
        const cut = messages.findIndex((m) => Number(m.offset) > last)
        end = cut === -1 ? messages.length : cut
      }
    }
    const chunk = messages.slice(i, end).map((m) => ({ partition, offset: m.offset, value: m.value }))
    await handleChunk(partition, chunk)
    const lastOffset = chunk[chunk.length - 1].offset
    resolveOffset(lastOffset)
    await commitOffsetsIfNecessary({
      topics: [{ topic: batch.topic, partitions: [{ partition, offset: String(Number(lastOffset) + 1) }] }],
    })
    await heartbeat()
    i = end
  }
}

/**
 * Every two seconds: publish this instance's partition positions, then
 * recompute the watermarks from every partition's position (any instance can
 * own any partition, so the shared hash in Valkey is the only complete view).
 */
async function reportPositions(admin: ReturnType<typeof kafka.admin>): Promise<void> {
  const now = Date.now()
  if (assigned.size > 0) {
    const [high, committed] = await Promise.all([
      admin.fetchTopicOffsets(config.kafka.topic),
      admin.fetchOffsets({ groupId: config.kafka.groupId, topics: [config.kafka.topic] }),
    ])
    const committedBy = new Map(committed[0]?.partitions.map((p) => [p.partition, Number(p.offset)]) ?? [])
    const current = (await redis.hgetall(keys.positions)) as Record<string, string>
    const updates: Record<string, string> = {}
    for (const p of assigned) {
      const highOffset = Number(high.find((h) => h.partition === p)?.high ?? 0)
      const done = nextOffset.get(p) ?? committedBy.get(p) ?? 0
      const lag = Math.max(0, highOffset - Math.max(done, 0))
      const prev = current[String(p)] ? (JSON.parse(current[String(p)]) as PartitionPosition).position : 0
      // No backlog: everything received so far is in ClickHouse. Otherwise we
      // only know up to the newest received_time we have processed.
      const position = lag === 0 ? now : Math.max(prev, lastReceived.get(p) ?? prev)
      updates[String(p)] = JSON.stringify({ position, updatedAt: now, lag } satisfies PartitionPosition)
    }
    await redis.hset(keys.positions, updates)
  }

  const all = (await redis.hgetall(keys.positions)) as Record<string, string>
  const parsed = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, JSON.parse(v) as PartitionPosition]))
  const report = computeWatermarks(parsed, config.kafka.partitions, now, config.latenessAllowanceMs, config.partitionStaleMs)
  watermarks = report.watermarks
  for (const stream of ['client', 'server'] as const) {
    const w = report.watermarks[stream]
    if (w !== null) watermarkLagSeconds.set({ stream }, (now - w) / 1000)
  }
}

async function main(): Promise<void> {
  await ensureClickHouseSchema()
  await ensureTopic()
  await refreshReference(true)
  setInterval(() => refreshReference().catch((err) => log.warn({ err: err.message }, 'reference refresh failed')), 15_000)

  const admin = kafka.admin()
  await admin.connect()
  const consumer = kafka.consumer({ groupId: config.kafka.groupId, sessionTimeout: 30_000, maxBytesPerPartition: 4 * 1024 * 1024 })
  consumer.on(consumer.events.GROUP_JOIN, (e) => {
    assigned.clear()
    for (const p of e.payload.memberAssignment[config.kafka.topic] ?? []) assigned.add(p)
    nextOffset.clear()
    log.info({ partitions: [...assigned] }, 'partitions assigned')
  })
  await consumer.connect()
  await consumer.subscribe({ topic: config.kafka.topic, fromBeginning: true })
  await consumer.run({ autoCommit: false, eachBatchAutoResolve: false, eachBatch })

  const tick = () =>
    reportPositions(admin)
      .catch((err) => log.warn({ err: err.message }, 'position report failed'))
      .finally(() => setTimeout(tick, 2000))
  tick()

  const app = express()
  app.get('/health', (_req, res) => res.json({ status: 'ok', partitions: [...assigned], watermarks }))
  app.get('/metrics', metricsHandler)
  const server = app.listen(config.ingestPort, () => log.info({ port: config.ingestPort }, 'ingest listening'))

  const shutdown = async () => {
    log.info('shutting down')
    server.close()
    await consumer.disconnect().catch(() => undefined)
    await admin.disconnect().catch(() => undefined)
    await Promise.allSettled([clickhouse.close(), pool.end(), redis.quit()])
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  log.fatal({ err }, 'ingest failed to start')
  process.exit(1)
})
