/**
 * Stream health: consumer lag and pending per group, DLQ depth, outbox
 * backlog and projection staleness. The workers export it as Prometheus
 * gauges; the API serves the same numbers to the streams page.
 * @module shared/monitor
 */
import type { Redis } from 'ioredis'
import { config } from './config.js'
import type { Queryable } from './db.js'
import { consumerLag, consumerPending, dlqDepth, projectionStaleness } from './metrics.js'
import { allPartitionKeys, GROUPS, groupInfo, type GroupInfo, type GroupName } from './stream.js'
import { parseEvent, InvalidEventError } from './events.js'
import type { AnyDomainEvent } from './events.js'

export interface GroupSummary {
  group: GroupName
  streams: GroupInfo[]
  lag: number
  pending: number
  consumers: number
}

export interface StreamHealth {
  groups: GroupSummary[]
  dlqDepth: number
  streamLengths: Record<string, number>
  outbox: { unpublished: number; oldestAgeSeconds: number | null }
  projection: { name: string; eventsApplied: number; lastRecordedAt: string | null; rebuiltAt: string | null; stalenessSeconds: number; updatedAt: string | null } | null
  eventsPerSecond: number
  eventsLastMinute: Record<string, number>
}

export async function streamHealth(redis: Redis, db: Queryable): Promise<StreamHealth> {
  const groups: GroupSummary[] = []
  for (const name of Object.keys(GROUPS) as GroupName[]) {
    const infos: GroupInfo[] = []
    for (const stream of GROUPS[name]()) {
      infos.push(...(await groupInfo(redis, stream)).filter((g) => g.group === name))
    }
    groups.push({
      group: name,
      streams: infos,
      lag: infos.reduce((s, g) => s + (g.lag ?? 0), 0),
      pending: infos.reduce((s, g) => s + g.pending, 0),
      consumers: Math.max(0, ...infos.map((g) => g.consumers)),
    })
  }
  const streamLengths: Record<string, number> = {}
  for (const key of [...allPartitionKeys(), config.streams.external, config.streams.deadLetter]) streamLengths[key] = await redis.xlen(key)

  const outbox = await db.query<{ n: number; oldest: Date | null }>('SELECT COUNT(*)::int AS n, MIN(recorded_at) AS oldest FROM events WHERE published_at IS NULL')
  const cp = await db.query('SELECT * FROM projection_checkpoints WHERE projection = $1', ['analytics'])
  const newest = await db.query<{ newest: Date | null }>('SELECT MAX(recorded_at) AS newest FROM events')
  const recent = await db.query<{ type: string; n: number }>(`SELECT type, COUNT(*)::int AS n FROM events WHERE recorded_at > now() - interval '60 seconds' GROUP BY type`)

  const row = cp.rows[0]
  const lastApplied = row?.last_recorded_at ? new Date(row.last_recorded_at).getTime() : null
  const newestAt = newest.rows[0]?.newest ? new Date(newest.rows[0].newest).getTime() : null
  const projector = groups.find((g) => g.group === 'projector')
  const behind = (projector?.lag ?? 0) + (projector?.pending ?? 0) > 0 || (outbox.rows[0].n ?? 0) > 0
  const stalenessSeconds = behind && newestAt && lastApplied ? Math.max(0, Math.round((newestAt - lastApplied) / 1000)) : 0
  const eventsLastMinute = Object.fromEntries(recent.rows.map((r) => [r.type, r.n]))

  return {
    groups,
    dlqDepth: streamLengths[config.streams.deadLetter] ?? 0,
    streamLengths,
    outbox: {
      unpublished: outbox.rows[0].n,
      oldestAgeSeconds: outbox.rows[0].oldest ? Math.round((Date.now() - new Date(outbox.rows[0].oldest).getTime()) / 1000) : null,
    },
    projection: row
      ? {
          name: 'analytics',
          eventsApplied: Number(row.events_applied),
          lastRecordedAt: row.last_recorded_at ? new Date(row.last_recorded_at).toISOString() : null,
          rebuiltAt: row.rebuilt_at ? new Date(row.rebuilt_at).toISOString() : null,
          stalenessSeconds,
          updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
        }
      : null,
    eventsPerSecond: Math.round((recent.rows.reduce((s, r) => s + r.n, 0) / 60) * 100) / 100,
    eventsLastMinute,
  }
}

/** Refreshes the Prometheus gauges every few seconds. */
export function startStreamMonitor(redis: Redis, db: Queryable, intervalMs = 3_000): NodeJS.Timeout {
  return setInterval(() => {
    streamHealth(redis, db)
      .then((h) => {
        for (const g of h.groups) {
          consumerLag.set({ group: g.group }, g.lag)
          consumerPending.set({ group: g.group }, g.pending)
        }
        dlqDepth.set(h.dlqDepth)
        if (h.projection) projectionStaleness.set({ projection: 'analytics' }, h.projection.stalenessSeconds)
      })
      .catch(() => undefined)
  }, intervalMs)
}

/** Parses the `event` field of a stream message; malformed input is a permanent (DLQ) failure. */
export function eventFromFields(fields: Record<string, string>): AnyDomainEvent {
  let raw: unknown
  try {
    raw = JSON.parse(fields.event ?? '')
  } catch {
    throw new InvalidEventError('message has no parseable event field')
  }
  return parseEvent(raw)
}
