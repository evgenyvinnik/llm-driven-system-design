/**
 * The analytics projection: quote volume by hour and client class, issue
 * kinds, firm completions, bookings and expiries (conversion), re-pricing,
 * dependency latency histograms and the source mix (live / cache / fallback)
 * per dependency.
 *
 * One pure function, `deltasFor`, maps an event to increments. The live
 * projector applies them event by event inside a transaction guarded by
 * processed_events. Replay folds every event from position 0 through the same
 * function. Every delta is a commutative increment bucketed by event time,
 * so arrival order and late events do not change the result, and replay
 * equals live.
 * @module projector/analytics
 */
import type pg from 'pg'
import type { Queryable } from '../shared/db.js'
import type { AnyDomainEvent } from '../shared/events.js'

export const PROJECTION = 'analytics'
export const INF = 2_147_483_647
export const LATENCY_BUCKETS = [10, 25, 50, 75, 100, 150, 200, 300, 400, 600, 800, 1_000, 1_500, 2_000, 3_000, 5_000, 10_000, 30_000, INF]

export type Delta =
  | { kind: 'counter'; bucket: string; metric: string; dimension: string; inc: number }
  | { kind: 'latency'; dependency: string; le: number; inc: number }
  | { kind: 'source'; dependency: string; source: string; inc: number }

export function hourBucket(iso: string): string {
  const d = new Date(iso)
  d.setUTCMinutes(0, 0, 0)
  return d.toISOString()
}

export function bucketFor(ms: number): number {
  return LATENCY_BUCKETS.find((le) => ms <= le) ?? INF
}

const counter = (e: AnyDomainEvent, metric: string, dimension: string): Delta => ({ kind: 'counter', bucket: hourBucket(e.occurred_at), metric, dimension, inc: 1 })

export function deltasFor(e: AnyDomainEvent): Delta[] {
  switch (e.type) {
    case 'QuoteRequested':
      return [counter(e, 'requested', e.payload.client_class)]
    case 'QuoteIssued': {
      const p = e.payload
      const out: Delta[] = []
      // An upcast v1 event has reason "unknown"; revision 1 is still recognisably the initial issue,
      // so a v1 firm completion (revision 2) isn't counted as a second issued quote.
      if (p.reason === 'initial' || (p.reason === 'unknown' && p.revision === 1)) out.push(counter(e, 'issued', p.kind))
      else if (p.reason === 'repriced_tariff' || p.reason === 'repriced_fuel') out.push(counter(e, 'repriced', p.reason))
      for (const c of p.price_components) {
        out.push({ kind: 'source', dependency: c.dependency, source: c.source, inc: 1 })
        if (c.source === 'live' && c.latency_ms !== null) out.push({ kind: 'latency', dependency: c.dependency, le: bucketFor(c.latency_ms), inc: 1 })
      }
      if (p.reason === 'initial' && p.latency_ms !== null) out.push({ kind: 'latency', dependency: 'quote_endpoint', le: bucketFor(p.latency_ms), inc: 1 })
      return out
    }
    case 'FirmQuoteCompleted':
      return [counter(e, 'firm_completed', 'all'), { kind: 'latency', dependency: 'firm_completion', le: bucketFor(e.payload.completion_ms), inc: 1 }]
    case 'QuoteBooked':
      return [counter(e, 'booked', e.payload.kind)]
    case 'QuoteExpired':
      return [counter(e, 'expired', e.payload.kind)]
    case 'TariffPublished':
      return [counter(e, 'tariff_published', 'all')]
    case 'FuelSurchargeChanged':
      return [counter(e, 'fuel_changed', 'all')]
    case 'DependencyCircuitOpened':
      return [counter(e, 'circuit_opened', e.payload.dependency)]
    case 'DependencyCircuitClosed':
      return [counter(e, 'circuit_closed', e.payload.dependency)]
  }
}

export interface ProjectionState {
  counters: Map<string, number>
  latency: Map<string, number>
  sources: Map<string, number>
}

export const emptyState = (): ProjectionState => ({ counters: new Map(), latency: new Map(), sources: new Map() })

const add = (m: Map<string, number>, k: string, inc: number) => m.set(k, (m.get(k) ?? 0) + inc)

export function applyDeltas(state: ProjectionState, deltas: Delta[]): void {
  for (const d of deltas) {
    if (d.kind === 'counter') add(state.counters, `${d.bucket}|${d.metric}|${d.dimension}`, d.inc)
    else if (d.kind === 'latency') add(state.latency, `${d.dependency}|${d.le}`, d.inc)
    else add(state.sources, `${d.dependency}|${d.source}`, d.inc)
  }
}

/** Folds events (duplicates ignored by event_id), as replay does. */
export function foldEvents(events: AnyDomainEvent[], state = emptyState(), seen = new Set<string>()): ProjectionState {
  for (const e of events) {
    if (seen.has(e.event_id)) continue
    seen.add(e.event_id)
    applyDeltas(state, deltasFor(e))
  }
  return state
}

/** Applies one event to the live tables. Returns false when this event was already applied. */
export async function applyLive(client: pg.PoolClient, e: AnyDomainEvent, position: number | null): Promise<boolean> {
  const fresh = await client.query('INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [PROJECTION, e.event_id])
  if (fresh.rowCount === 0) return false
  for (const d of deltasFor(e)) {
    if (d.kind === 'counter') {
      await client.query(
        `INSERT INTO analytics_counters (bucket, metric, dimension, value) VALUES ($1, $2, $3, $4)
         ON CONFLICT (bucket, metric, dimension) DO UPDATE SET value = analytics_counters.value + EXCLUDED.value`,
        [d.bucket, d.metric, d.dimension, d.inc],
      )
    } else if (d.kind === 'latency') {
      await client.query(
        `INSERT INTO analytics_latency (dependency, le_ms, count) VALUES ($1, $2, $3)
         ON CONFLICT (dependency, le_ms) DO UPDATE SET count = analytics_latency.count + EXCLUDED.count`,
        [d.dependency, d.le, d.inc],
      )
    } else {
      await client.query(
        `INSERT INTO analytics_sources (dependency, source, count) VALUES ($1, $2, $3)
         ON CONFLICT (dependency, source) DO UPDATE SET count = analytics_sources.count + EXCLUDED.count`,
        [d.dependency, d.source, d.inc],
      )
    }
  }
  await client.query(
    `INSERT INTO projection_checkpoints (projection, events_applied, max_position, last_recorded_at, updated_at) VALUES ($1, 1, $2, $3, now())
     ON CONFLICT (projection) DO UPDATE SET events_applied = projection_checkpoints.events_applied + 1,
       max_position = GREATEST(projection_checkpoints.max_position, EXCLUDED.max_position),
       last_recorded_at = GREATEST(projection_checkpoints.last_recorded_at, EXCLUDED.last_recorded_at), updated_at = now()`,
    [PROJECTION, position ?? 0, e.recorded_at],
  )
  return true
}

export async function readLiveState(db: Queryable): Promise<ProjectionState> {
  const state = emptyState()
  const counters = await db.query<{ bucket: Date; metric: string; dimension: string; value: number }>('SELECT bucket, metric, dimension, value FROM analytics_counters')
  for (const r of counters.rows) state.counters.set(`${new Date(r.bucket).toISOString()}|${r.metric}|${r.dimension}`, Number(r.value))
  const latency = await db.query<{ dependency: string; le_ms: number; count: number }>('SELECT dependency, le_ms, count FROM analytics_latency')
  for (const r of latency.rows) state.latency.set(`${r.dependency}|${r.le_ms}`, Number(r.count))
  const sources = await db.query<{ dependency: string; source: string; count: number }>('SELECT dependency, source, count FROM analytics_sources')
  for (const r of sources.rows) state.sources.set(`${r.dependency}|${r.source}`, Number(r.count))
  return state
}

/** Differences between two states, as readable lines; empty when they match. */
export function diffStates(expected: ProjectionState, actual: ProjectionState): string[] {
  const out: string[] = []
  for (const table of ['counters', 'latency', 'sources'] as const) {
    const keys = new Set([...expected[table].keys(), ...actual[table].keys()])
    for (const k of keys) {
      const a = expected[table].get(k) ?? 0
      const b = actual[table].get(k) ?? 0
      if (a !== b) out.push(`${table} ${k}: replay=${a} live=${b}`)
    }
  }
  return out
}

/** Percentile from a cumulative histogram (bucket upper bounds). */
export function histogramPercentile(buckets: { le: number; count: number }[], p: number): number | null {
  const sorted = [...buckets].sort((a, b) => a.le - b.le)
  const total = sorted.reduce((s, b) => s + b.count, 0)
  if (total === 0) return null
  const target = Math.ceil((p / 100) * total)
  let seen = 0
  for (const b of sorted) {
    seen += b.count
    if (seen >= target) return b.le
  }
  return sorted[sorted.length - 1].le
}
