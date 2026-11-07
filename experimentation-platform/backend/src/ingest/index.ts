/**
 * Ingest worker: drains the Valkey event stream into ClickHouse.
 *
 * Order of effects per group of stream entries (one entry = one SDK batch):
 *   1. read: own pending entries first (after a crash, the same entries in the
 *      same order and count), then new ones
 *   2. insert each table's rows with insert_deduplication_token = sha1(table + entry ids)
 *   3. XACK the entries
 * A crash between 2 and 3 re-reads the same entries → same token → ClickHouse
 * drops the repeated insert. Entries of a consumer that never comes back are
 * claimed by another after WORKER_CLAIM_IDLE_MS; that regrouping changes the
 * token, and ReplacingMergeTree on event_id is what collapses the duplicates.
 */
import express from 'express'
import { createRedisConnection, keys, redis } from '../shared/cache.js'
import { chInsert, clickhouse, ensureClickHouseSchema } from '../shared/clickhouse.js'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'
import { metricsHandler, workerInsertSeconds, workerLag, workerRows } from '../shared/metrics.js'
import { insertToken, toClickHouseRows, type StreamBatch } from './batch.js'

type Entry = [id: string, fields: string[] | null]
type ReadReply = [stream: string, entries: Entry[]][] | null

const log = logger.child({ component: 'ingest-worker', worker: config.worker.id })
const reader = createRedisConnection('ingest-reader')
const consumer = config.worker.id
const N = config.worker.entriesPerInsert
let stopping = false
let lastBatchAt: number | null = null
let rowsTotal = 0

async function ensureGroup(): Promise<void> {
  try {
    await redis.xgroup('CREATE', keys.eventStream, keys.eventGroup, '0', 'MKSTREAM')
  } catch (err) {
    if (!String((err as Error).message).includes('BUSYGROUP')) throw err
  }
}

function parse(entries: Entry[]): { ids: string[]; batches: StreamBatch[] } {
  const ids: string[] = []
  const batches: StreamBatch[] = []
  for (const [id, fields] of entries) {
    ids.push(id)
    if (!fields) continue // trimmed from the stream; nothing to insert
    const i = fields.indexOf('b')
    if (i < 0) continue
    try {
      batches.push(JSON.parse(fields[i + 1]) as StreamBatch)
    } catch {
      log.warn({ id }, 'unparseable stream entry skipped')
    }
  }
  return { ids, batches }
}

async function insertWithRetry(table: string, rows: object[], token: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const end = workerInsertSeconds.startTimer()
      await chInsert(table, rows, token)
      end()
      workerRows.inc({ table }, rows.length)
      return
    } catch (err) {
      if (attempt >= 5) throw err
      log.warn({ table, attempt, err: (err as Error).message }, 'insert failed; retrying with the same token')
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt))
    }
  }
}

async function processEntries(entries: Entry[]): Promise<void> {
  if (entries.length === 0) return
  const { ids, batches } = parse(entries)
  const rows = toClickHouseRows(batches)
  await insertWithRetry('exposures', rows.exposures, insertToken('exposures', ids))
  await insertWithRetry('assignments', rows.assignments, insertToken('assignments', ids))
  await insertWithRetry('conversions', rows.conversions, insertToken('conversions', ids))
  await redis.xack(keys.eventStream, keys.eventGroup, ...ids)
  lastBatchAt = Date.now()
  rowsTotal += rows.exposures.length + rows.assignments.length + rows.conversions.length
  log.debug({ entries: ids.length, exposures: rows.exposures.length, assignments: rows.assignments.length, conversions: rows.conversions.length }, 'batch inserted')
}

async function read(id: '0' | '>', block: boolean): Promise<Entry[]> {
  const args: (string | number)[] = ['GROUP', keys.eventGroup, consumer, 'COUNT', N]
  if (block) args.push('BLOCK', config.worker.blockMs)
  args.push('STREAMS', keys.eventStream, id)
  const reply = (await (reader.xreadgroup as (...a: (string | number)[]) => Promise<unknown>)(...args)) as ReadReply
  return reply?.[0]?.[1] ?? []
}

async function claimAbandoned(): Promise<void> {
  const reply = (await redis.xautoclaim(keys.eventStream, keys.eventGroup, consumer, config.worker.claimIdleMs, '0-0', 'COUNT', N)) as [string, Entry[], string[]?]
  const claimed = reply?.[1] ?? []
  if (claimed.length > 0) {
    log.warn({ claimed: claimed.length }, 'claimed entries abandoned by another consumer')
    await processEntries(claimed)
  }
}

async function updateLag(): Promise<void> {
  try {
    const groups = (await redis.xinfo('GROUPS', keys.eventStream)) as unknown[][]
    const group = groups.find((g) => g[1] === keys.eventGroup)
    if (!group) return
    const field = (name: string) => group[group.indexOf(name) + 1]
    const lag = Number(field('lag') ?? 0) + Number(field('pending') ?? 0)
    workerLag.set(lag)
    await redis.set(keys.workerHeartbeat, JSON.stringify({ id: consumer, at: Date.now(), lastBatchAt, rowsTotal, lag }), 'EX', 60)
  } catch {
    // stream not created yet
  }
}

async function run(): Promise<void> {
  await ensureClickHouseSchema()
  await ensureGroup()
  // Anything this consumer read but never acknowledged (a crash mid-batch) goes first, same grouping.
  for (;;) {
    const pending = await read('0', false)
    if (pending.length === 0) break
    log.info({ entries: pending.length }, 'reprocessing own pending entries')
    await processEntries(pending)
  }
  let lastClaim = 0
  let lastLag = 0
  while (!stopping) {
    try {
      if (Date.now() - lastClaim > 15_000) {
        lastClaim = Date.now()
        await claimAbandoned()
      }
      await processEntries(await read('>', true))
      if (Date.now() - lastLag > 2_000) {
        lastLag = Date.now()
        await updateLag()
      }
    } catch (err) {
      log.error({ err: (err as Error).message }, 'worker iteration failed; entries stay pending and will be retried')
      await new Promise((r) => setTimeout(r, 2_000))
      // Retry what is pending for us before reading anything new, keeping the grouping.
      for (;;) {
        const pending = await read('0', false).catch(() => [] as Entry[])
        if (pending.length === 0) break
        try {
          await processEntries(pending)
        } catch {
          break
        }
      }
    }
  }
}

const app = express()
app.get('/health', (_req, res) => res.json({ status: 'ok', worker: consumer, lastBatchAt, rowsTotal }))
app.get('/metrics', metricsHandler)
const server = app.listen(config.worker.port, () => log.info({ port: config.worker.port }, 'ingest worker health/metrics listening'))
// Another process on the metrics port must not stop ingest.
server.on('error', (err: NodeJS.ErrnoException) => log.warn({ err: err.code, port: config.worker.port }, 'metrics port unavailable; continuing without it'))

async function shutdown(signal: string) {
  log.info({ signal }, 'shutting down')
  stopping = true
  server.close()
  reader.disconnect()
  await Promise.allSettled([redis.quit(), clickhouse.close()])
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

run().catch((err) => {
  log.error({ err }, 'ingest worker crashed')
  process.exit(1)
})
