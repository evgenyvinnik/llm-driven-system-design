/**
 * Stream operations: consumer lag and pending per group and partition, projection staleness, DLQ depth,
 * the outbox backlog and throughput; listing and redriving dead letters.
 * @module api/services/streams
 */
import { redis } from '../../shared/cache.js'
import { pool } from '../../shared/db.js'
import { consumerLag, consumerPending, dlqDepth, projectionStaleness } from '../../shared/metrics.js'
import { dlqKey, fieldsToObject, GROUPS, idTime, partitionStreams, retryKey, TOPICS } from '../../shared/streams.js'
import { HttpError } from '../../shared/errors.js'

function pairs(flat: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (let i = 0; i + 1 < flat.length; i += 2) out[String(flat[i])] = flat[i + 1]
  return out
}

interface GroupStream {
  stream: string
  lag: number
  pending: number
  lastDeliveredId: string
  oldestUnfinishedAt: number | null
  consumers: number
}

async function groupOnStream(stream: string, group: string): Promise<GroupStream | null> {
  let groups: unknown[][]
  try {
    groups = (await redis.call('XINFO', 'GROUPS', stream)) as unknown[][]
  } catch {
    return null
  }
  const info = groups.map(pairs).find((g) => g.name === group)
  if (!info) return null
  const pending = Number(info.pending ?? 0)
  const lastDeliveredId = String(info['last-delivered-id'] ?? '0-0')
  let lag = info.lag === null || info.lag === undefined ? 0 : Number(info.lag)
  let oldest: number | null = null
  if (lag > 0 || info.lag === null) {
    const next = (await redis.xrange(stream, `(${lastDeliveredId}`, '+', 'COUNT', 1)) as Array<[string, string[]]>
    if (next[0]) oldest = idTime(next[0][0])
    if (info.lag === null) lag = next.length ? Number((await redis.xlen(stream)) || 0) : 0
  }
  if (pending > 0) {
    const summary = (await redis.xpending(stream, group)) as [number, string | null, string | null, unknown]
    const t = idTime(summary[1])
    if (t !== null && (oldest === null || t < oldest)) oldest = t
  }
  return { stream, lag, pending, lastDeliveredId, oldestUnfinishedAt: oldest, consumers: Number(info.consumers ?? 0) }
}

export async function streamsOverview() {
  const now = Date.now()
  const topics = []
  for (const topic of TOPICS) {
    const partitions = []
    for (const stream of partitionStreams(topic)) {
      const length = await redis.xlen(stream)
      const last = (await redis.xrevrange(stream, '+', '-', 'COUNT', 1)) as Array<[string, string[]]>
      partitions.push({ stream, length, lastId: last[0]?.[0] ?? null, lastAt: last[0] ? new Date(idTime(last[0][0])!).toISOString() : null })
    }
    topics.push({ topic, partitions })
  }

  const { rows: checkpoints } = await pool.query<{ consumer: string; events_processed: number; duplicates: number; last_recorded_at: Date | null; updated_at: Date }>(
    'SELECT consumer, events_processed, duplicates, last_recorded_at, updated_at FROM consumer_checkpoints',
  )
  const cp = new Map(checkpoints.map((c) => [c.consumer, c]))
  const groups = []
  for (const [group, groupTopics] of Object.entries(GROUPS)) {
    const streams: GroupStream[] = []
    for (const stream of [...groupTopics.flatMap((t) => partitionStreams(t)), retryKey(group)]) {
      const g = await groupOnStream(stream, group)
      if (g) streams.push(g)
    }
    const lag = streams.reduce((s, x) => s + x.lag, 0)
    const pending = streams.reduce((s, x) => s + x.pending, 0)
    const oldest = streams.map((s) => s.oldestUnfinishedAt).filter((x): x is number => x !== null)
    const staleness = oldest.length ? Math.max(0, Math.round((now - Math.min(...oldest)) / 1000)) : 0
    const dlq = await redis.xlen(dlqKey(group))
    const owners = await Promise.all(groupTopics.flatMap((t) => partitionStreams(t)).map(async (s) => ({ stream: s, owner: await redis.get(`tp:lease:${group}:${s}`) })))
    consumerPending.set({ group, stream: 'all' }, pending)
    for (const s of streams) {
      consumerLag.set({ group, stream: s.stream }, s.lag)
      consumerPending.set({ group, stream: s.stream }, s.pending)
    }
    projectionStaleness.set({ group }, staleness)
    dlqDepth.set({ group }, dlq)
    const c = cp.get(group)
    groups.push({
      group,
      topics: groupTopics,
      lag,
      pending,
      stalenessSeconds: staleness,
      dlqDepth: dlq,
      processed: c?.events_processed ?? 0,
      duplicates: c?.duplicates ?? 0,
      lastProcessedAt: c?.updated_at ?? null,
      owners,
      streams: streams.map((s) => ({ ...s, oldestUnfinishedAt: s.oldestUnfinishedAt ? new Date(s.oldestUnfinishedAt).toISOString() : null })),
    })
  }

  const { rows: outbox } = await pool.query<{ backlog: number; last_position: number | null; published_through: number | null }>(
    `SELECT COUNT(*) FILTER (WHERE published_at IS NULL)::int AS backlog, MAX(position) AS last_position,
            MAX(position) FILTER (WHERE published_at IS NOT NULL) AS published_through FROM events`,
  )
  const { rows: rate } = await pool.query<{ bucket: Date; n: number }>(
    `SELECT date_trunc('second', inserted_at) - make_interval(secs => (extract(second FROM inserted_at)::int % 5)) AS bucket, COUNT(*)::int AS n
       FROM events WHERE inserted_at > now() - interval '5 minutes' GROUP BY 1 ORDER BY 1`,
  )
  const { rows: last60 } = await pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM events WHERE inserted_at > now() - interval '60 seconds'")
  const { rows: byType } = await pool.query<{ type: string; version: number; n: number }>('SELECT type, version, COUNT(*)::int AS n FROM events GROUP BY type, version ORDER BY type, version')
  const { rows: replays } = await pool.query('SELECT * FROM replay_runs ORDER BY id DESC LIMIT 10')
  return {
    topics,
    groups,
    outbox: outbox[0],
    rates: { eventsPerSecond: Math.round((last60[0].n / 60) * 10) / 10, series: rate.map((r) => ({ at: r.bucket.toISOString(), perSecond: Math.round((r.n / 5) * 10) / 10 })) },
    eventTypes: byType,
    replays,
  }
}

export interface DlqEntry {
  group: string
  id: string
  stream: string
  messageId: string
  eventId: string
  type: string
  key: string
  error: string
  deliveries: number
  deadAt: string
}

export async function listDlq(): Promise<DlqEntry[]> {
  const out: DlqEntry[] = []
  for (const group of Object.keys(GROUPS)) {
    const entries = (await redis.xrevrange(dlqKey(group), '+', '-', 'COUNT', 200)) as Array<[string, string[]]>
    for (const [id, raw] of entries) {
      const f = fieldsToObject(raw)
      out.push({ group, id, stream: f.stream, messageId: f.messageId, eventId: f.eventId, type: f.type, key: f.key, error: f.error, deliveries: Number(f.deliveries), deadAt: f.deadAt })
    }
  }
  return out.sort((a, b) => (a.deadAt < b.deadAt ? 1 : -1))
}

/**
 * Redrive: put the dead letter on the group's own retry stream (only that group reads it, so groups that
 * already processed the event are not bothered), then delete it from the DLQ.
 */
export async function redrive(group: string, entryId: string): Promise<{ retryId: string }> {
  if (!GROUPS[group]) throw new HttpError(404, 'NOT_FOUND', `Unknown consumer group ${group}`)
  const entries = (await redis.xrange(dlqKey(group), entryId, entryId)) as Array<[string, string[]]>
  if (!entries[0]) throw new HttpError(404, 'NOT_FOUND', 'Dead letter not found (already redriven?)')
  const f = fieldsToObject(entries[0][1])
  const retryId = (await redis.xadd(retryKey(group), '*', 'id', f.eventId, 'type', f.type, 'key', f.key, 'e', f.e, 'redrivenFrom', entryId)) as string
  await redis.xdel(dlqKey(group), entryId)
  return { retryId }
}
