/**
 * Operational view of the event pipeline, for the Ops page and the Prometheus
 * gauges: relay lag, consumer lag and pending per group and stream, DLQ depth,
 * events per second, and projection staleness (age of the oldest committed
 * event a group has not applied yet).
 * @module events/ops
 */
import type { Redis } from 'ioredis'
import { config } from '../shared/config.js'
import { pool, type Queryable } from '../shared/db.js'
import { FAMILIES, streamKey } from '../shared/stream.js'
import { dlqDepth } from './dlq.js'
import { GROUPS } from './topology.js'

export interface GroupStreamStats {
  family: string
  key: string
  lag: number | null
  pending: number
  consumers: number
  lastDeliveredId: string | null
  checkpointPosition: number
  eventsHandled: number
  stalenessSeconds: number
  behindEvents: number
  checkpointAt: string | null
}

export interface GroupStats {
  group: string
  kind: string
  description: string
  handles: string[]
  tables: string[]
  streams: GroupStreamStats[]
  lag: number
  pending: number
  stalenessSeconds: number
  eventsHandled: number
}

export interface OpsOverview {
  head: { position: number; committedAt: string | null; totalEvents: number }
  relay: { checkpoint: number; lag: number; updatedAt: string | null }
  eventsPerSecond: { last10s: number; last60s: number; series: Array<{ t: number; n: number }> }
  streams: Array<{ family: string; key: string; length: number; lastEventPosition: number }>
  groups: GroupStats[]
  dlq: { depth: number }
  timers: { pending: number; overdue: number; fired: number }
  byType: Array<{ type: string; n: number }>
  sampledAt: string
}

function infoToObject(row: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (let i = 0; i + 1 < row.length; i += 2) out[String(row[i])] = row[i + 1]
  return out
}

async function groupInfo(redis: Redis, key: string): Promise<Map<string, Record<string, unknown>>> {
  try {
    const groups = (await redis.xinfo('GROUPS', key)) as unknown[][]
    return new Map(groups.map((g) => infoToObject(g)).map((g) => [String(g.name), g]))
  } catch {
    return new Map()
  }
}

export async function opsOverview(redis: Redis, db: Queryable = pool, nowDomainMs = Date.now()): Promise<OpsOverview> {
  const [head, relay, eps, checkpoints, byType, byFamily, timers] = await Promise.all([
    db.query<{ p: number | null; at: Date | null; n: number }>('SELECT max(global_position) AS p, max(committed_at) AS at, count(*)::int AS n FROM events'),
    db.query<{ last_position: number; updated_at: Date }>('SELECT last_position, updated_at FROM relay_checkpoint WHERE id = 1'),
    db.query<{ s: number; n: number }>(
      `SELECT floor(extract(epoch FROM committed_at))::bigint AS s, count(*)::int AS n FROM events WHERE committed_at > now() - interval '60 seconds' GROUP BY 1 ORDER BY 1`,
    ),
    db.query<{ group_name: string; stream_key: string; last_position: number; events_handled: number; updated_at: Date }>('SELECT * FROM consumer_checkpoints'),
    db.query<{ type: string; n: number }>('SELECT type, count(*)::int AS n FROM events GROUP BY type ORDER BY 2 DESC'),
    db.query<{ family: string; p: number }>('SELECT family, max(global_position) AS p FROM events GROUP BY family'),
    db.query<{ pending: number; overdue: number; fired: number }>(
      `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending, count(*) FILTER (WHERE status = 'pending' AND due_at <= $1)::int AS overdue,
              count(*) FILTER (WHERE status = 'fired')::int AS fired FROM ack_timers`,
      [new Date(nowDomainMs)],
    ),
  ])
  const headPos = Number(head.rows[0]?.p ?? 0)
  const relayCp = Number(relay.rows[0]?.last_position ?? 0)
  const nowSec = Math.floor(Date.now() / 1000)
  const series = Array.from({ length: 60 }, (_, i) => {
    const t = nowSec - 59 + i
    return { t, n: eps.rows.find((r) => Number(r.s) === t)?.n ?? 0 }
  })
  const sum = (from: number) => series.slice(from).reduce((s, x) => s + x.n, 0)

  const infos = new Map<string, Map<string, Record<string, unknown>>>()
  const streams = []
  for (const family of FAMILIES) {
    const key = streamKey(family)
    infos.set(key, await groupInfo(redis, key))
    const length = await redis.xlen(key).catch(() => 0)
    streams.push({ family, key, length, lastEventPosition: Number(byFamily.rows.find((r) => r.family === family)?.p ?? 0) })
  }

  const groups: GroupStats[] = []
  for (const g of GROUPS) {
    const rows: GroupStreamStats[] = []
    for (const family of g.families) {
      const key = streamKey(family)
      const info = infos.get(key)?.get(g.group)
      const cp = checkpoints.rows.find((c) => c.group_name === g.group && c.stream_key === key)
      const position = Number(cp?.last_position ?? 0)
      const stale = await db.query<{ age: number | null; n: number }>(
        `SELECT extract(epoch FROM now() - min(committed_at))::float AS age, count(*)::int AS n
           FROM events WHERE family = $1 AND global_position > $2 AND type = ANY($3)`,
        [family, position, g.handles],
      )
      rows.push({
        family, key,
        lag: info?.lag === null || info?.lag === undefined ? null : Number(info.lag),
        pending: Number(info?.pending ?? 0),
        consumers: Number(info?.consumers ?? 0),
        lastDeliveredId: info ? String(info['last-delivered-id']) : null,
        checkpointPosition: position,
        eventsHandled: Number(cp?.events_handled ?? 0),
        stalenessSeconds: Math.max(0, Math.round((stale.rows[0]?.age ?? 0) * 10) / 10),
        behindEvents: stale.rows[0]?.n ?? 0,
        checkpointAt: cp?.updated_at?.toISOString() ?? null,
      })
    }
    groups.push({
      group: g.group, kind: g.kind, description: g.description, handles: g.handles, tables: g.tables ?? [], streams: rows,
      lag: rows.reduce((s, r) => s + (r.lag ?? 0), 0),
      pending: rows.reduce((s, r) => s + r.pending, 0),
      stalenessSeconds: Math.max(0, ...rows.map((r) => r.stalenessSeconds)),
      eventsHandled: rows.reduce((s, r) => s + r.eventsHandled, 0),
    })
  }

  return {
    head: { position: headPos, committedAt: head.rows[0]?.at?.toISOString() ?? null, totalEvents: head.rows[0]?.n ?? 0 },
    relay: { checkpoint: relayCp, lag: Math.max(0, headPos - relayCp), updatedAt: relay.rows[0]?.updated_at?.toISOString() ?? null },
    eventsPerSecond: { last10s: Math.round((sum(50) / 10) * 10) / 10, last60s: Math.round((sum(0) / 60) * 10) / 10, series },
    streams,
    groups,
    dlq: { depth: await dlqDepth(redis).catch(() => 0) },
    timers: timers.rows[0],
    byType: byType.rows,
    sampledAt: new Date().toISOString(),
  }
}

export const DLQ_KEY = config.stream.deadLetterKey
