/**
 * Dashboard queries: KPI overview, time series with aligned comparisons,
 * breakdowns with small-cohort suppression, and drill-downs that re-run the
 * chart's own predicate against raw events.
 *
 * Access is applied here, not in the client: billing metrics are left out of
 * responses entirely for roles without billing:read, and drill-down rows never
 * include a cost column for them.
 * @module api/services/query-service
 */
import { keys, redis } from '../../shared/cache.js'
import { chQuery } from '../../shared/clickhouse.js'
import { config } from '../../shared/config.js'
import type { OrgAccess } from '../../shared/auth.js'
import { pool } from '../../shared/db.js'
import { HttpError } from '../../shared/errors.js'
import { queryCache, queryDuration } from '../../shared/metrics.js'
import { bucketsFor, localDate, MINUTE, shiftBack, type Bucket } from '../../shared/time.js'
import { computeWatermarks, type PartitionPosition, type WatermarkReport } from '../../shared/watermark.js'
import type { Stream } from '../../shared/contract.js'
import { EMPTY_AGGREGATES, METRIC_BY_ID, METRICS, OVERVIEW_METRICS, type Aggregates, type Dimension, type MetricDef } from './catalog.js'
import { planWindow } from './planner.js'
import { cacheKey, canonicalString, type Filters } from './query-spec.js'
import { drillWhere, seriesSql, toAggregates, windowSql, type AggregateRow, type Scope } from './sql.js'

export interface QueryContext {
  access: OrgAccess
  filters: Filters
  signal?: AbortSignal
  now?: number
}

// ─── Freshness ────────────────────────────────────────────────────────────────

export async function readWatermarks(now = Date.now()): Promise<WatermarkReport> {
  const raw = (await redis.hgetall(keys.positions)) as Record<string, string>
  const positions = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, JSON.parse(v) as PartitionPosition]))
  return computeWatermarks(positions, config.kafka.partitions, now, config.latenessAllowanceMs, config.partitionStaleMs)
}

/** The watermark that bounds a metric: the earliest over the streams it reads. Null when unknown. */
export function watermarkFor(report: WatermarkReport, streams: Stream[]): number | null {
  const values = streams.map((s) => report.watermarks[s])
  if (values.some((v) => v === null)) return null
  return Math.min(...(values as number[]))
}

// ─── Coverage ─────────────────────────────────────────────────────────────────

export interface Coverage {
  metric: string
  /** UTC instants (midnight UTC of the stored dates). */
  collectedFrom: number
  availableFrom: number
  note: string
}

let coverageCache: { at: number; value: Map<string, Coverage> } | null = null

export async function getCoverage(): Promise<Map<string, Coverage>> {
  if (coverageCache && Date.now() - coverageCache.at < 15_000) return coverageCache.value
  const { rows } = await pool.query<{ metric: string; collected_from: string; available_from: string; note: string }>(
    "SELECT metric, to_char(collected_from, 'YYYY-MM-DD') AS collected_from, to_char(available_from, 'YYYY-MM-DD') AS available_from, note FROM metric_coverage",
  )
  const value = new Map(
    rows.map((r) => [
      r.metric,
      { metric: r.metric, collectedFrom: Date.parse(`${r.collected_from}T00:00:00Z`), availableFrom: Date.parse(`${r.available_from}T00:00:00Z`), note: r.note },
    ]),
  )
  coverageCache = { at: Date.now(), value }
  return value
}

export function invalidateCoverage(): void {
  coverageCache = null
}

export type CoverageState = 'ok' | 'not_collected' | 'backfill_pending'

/** A bucket counts as covered only if it starts after collection began; a half-collected bucket would understate. */
export function coverageState(cov: Coverage | undefined, bucketStart: number): CoverageState {
  if (!cov) return 'ok'
  if (bucketStart < cov.collectedFrom) return 'not_collected'
  if (bucketStart < cov.availableFrom) return 'backfill_pending'
  return 'ok'
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function visibleMetric(access: OrgAccess, id: string): MetricDef {
  const metric = METRIC_BY_ID.get(id)
  if (!metric) throw new HttpError(400, 'UNKNOWN_METRIC', `Unknown metric ${id}`)
  if (metric.sensitivity === 'billing' && !access.permissions.includes('billing:read')) {
    // The value is never computed for this caller, let alone sent.
    throw new HttpError(403, 'METRIC_FORBIDDEN', `${metric.label} is billing data; your role (${access.role}) cannot see it`)
  }
  return metric
}

/** The filtered or broken-down dimension this metric cannot be split by, if any. */
export function inapplicableDimension(metric: MetricDef, f: Filters, breakdownDim?: Dimension): Dimension | null {
  const used: Dimension[] = [...(f.models.length ? (['model'] as const) : []), ...(f.features.length ? (['feature'] as const) : []), ...(breakdownDim ? [breakdownDim] : [])]
  return used.find((d) => !metric.dimensions.includes(d)) ?? null
}

/**
 * A metric filtered by a dimension it doesn't carry would silently read 0
 * (conversations start before any feature is used). Refuse with the reason.
 */
function assertApplicable(metric: MetricDef, f: Filters, breakdownDim?: Dimension): void {
  const dim = inapplicableDimension(metric, f, breakdownDim)
  if (dim) throw new HttpError(422, 'DIMENSION_NOT_APPLICABLE', `${metric.label} can't be split by ${dim}: ${metric.dimensionNote ?? 'its events do not carry it'}`)
}

export function visibleMetrics(access: OrgAccess): MetricDef[] {
  const billing = access.permissions.includes('billing:read')
  return METRICS.filter((m) => m.sensitivity !== 'billing' || billing)
}

/** A filtered cohort (model or feature selected) with fewer distinct users than the threshold. */
function isSmallCohort(narrowed: boolean, a: Aggregates): boolean {
  return narrowed && a.active_users > 0 && a.active_users < config.minCohortUsers
}

function scopeOf(f: Filters): Scope {
  return { org: f.org, models: f.models, features: f.features }
}

async function timed<T>(widget: string, fn: () => Promise<T>): Promise<T> {
  const end = queryDuration.startTimer({ widget })
  try {
    return await fn()
  } finally {
    end()
  }
}

/** Aggregates for any window, merged across rollups and raw edges by the planner. */
export async function windowAggregates(scope: Scope, from: number, to: number, timeZone: string, now: number, signal?: AbortSignal, dims: string[] = []): Promise<AggregateRow[]> {
  const pieces = planWindow(from, to, timeZone, { now, minuteRetentionMs: 2 * 86_400_000 })
  if (pieces.length === 0) return []
  const { sql, params } = windowSql(pieces, scope, dims)
  return chQuery<AggregateRow>(sql, params, signal)
}

async function seriesRows(scope: Scope, buckets: Bucket[], grain: Filters['grain'], signal?: AbortSignal): Promise<Map<string, Aggregates>> {
  if (buckets.length === 0) return new Map()
  const first = buckets[0]
  const last = buckets[buckets.length - 1]
  const { sql, params } =
    grain === 'day' ? seriesSql('day', first.key, nextDate(last.key), scope) : seriesSql(grain, first.start, last.end, scope)
  const rows = await chQuery<AggregateRow>(sql, params, signal)
  return new Map(rows.map((r) => [grain === 'day' ? r.k! : new Date(`${r.k!.replace(' ', 'T')}Z`).toISOString(), toAggregates(r)]))
}

/** Rollup rows for whole buckets; clipped edge buckets go through the planner (minute rollups or raw events). */
async function bucketAggregates(scope: Scope, buckets: Bucket[], grain: Filters['grain'], timeZone: string, now: number, signal?: AbortSignal): Promise<Map<string, Aggregates>> {
  const map = await seriesRows(scope, buckets.filter((b) => !b.clipped), grain, signal)
  for (const b of buckets.filter((x) => x.clipped)) {
    const rows = await windowAggregates(scope, b.start, b.end, timeZone, now, signal)
    map.set(b.key, rows[0] ? toAggregates(rows[0]) : EMPTY_AGGREGATES)
  }
  return map
}

/** The previous period's bucket for each current bucket, shifted by local wall-clock time. */
function shiftedBuckets(buckets: Bucket[], f: Filters, timeZone: string): Bucket[] {
  return buckets.map((b) => {
    const start = shiftBack(b.start, f.compare, timeZone)
    const end = shiftBack(b.end, f.compare, timeZone)
    if (f.grain === 'day') return { start, end, key: localDate(start, timeZone) }
    const step = f.grain === 'hour' ? 3_600_000 : MINUTE
    const aligned = start % step === 0 && end - start === step
    return { start, end, key: new Date(start).toISOString(), ...(aligned ? {} : { clipped: true }) }
  })
}

function nextDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

// ─── Cache ────────────────────────────────────────────────────────────────────

/** Late events bump a per-day revision; a cached window is only valid for the revisions it was computed at. */
async function revisionsFor(org: string, from: number, to: number, timeZone: string): Promise<string> {
  const days = bucketsFor(from, to, 'day', timeZone).map((b) => b.key)
  if (days.length === 0) return '0'
  const values = await redis.hmget(keys.revision(org), ...days)
  return values.map((v) => v ?? '0').join('.')
}

export async function cached<T>(
  widget: string,
  ctx: QueryContext,
  extra: Record<string, string | number | undefined>,
  sealedBefore: number | null,
  compute: () => Promise<T>,
): Promise<{ data: T; echo: string; cache: 'hit' | 'miss' }> {
  const f = ctx.filters
  const echo = canonicalString(f, extra)
  const lookback = f.compare === 'none' ? f.from : shiftBack(f.from, f.compare, ctx.access.timeZone)
  const revision = await revisionsFor(f.org, lookback, f.to, ctx.access.timeZone)
  const key = keys.query(cacheKey(widget, echo, [...ctx.access.permissions].sort().join(','), revision))
  const hit = await redis.get(key).catch(() => null)
  if (hit) {
    queryCache.inc({ widget, result: 'hit' })
    return { data: JSON.parse(hit) as T, echo, cache: 'hit' }
  }
  queryCache.inc({ widget, result: 'miss' })
  const data = await timed(widget, compute)
  // A window that ends before the watermark only changes when late data bumps its revision.
  const ttl = sealedBefore !== null && f.to <= sealedBefore ? config.sealedWindowCacheSeconds : config.openWindowCacheSeconds
  await redis.set(key, JSON.stringify(data), 'EX', ttl).catch(() => undefined)
  return { data, echo, cache: 'miss' }
}

// ─── Overview (KPI tiles) ─────────────────────────────────────────────────────

export interface Tile {
  id: string
  label: string
  unit: MetricDef['unit']
  approximate: boolean
  higherIsBetter: boolean | null
  value: number | null
  previous: number | null
  /** Relative change for counts, absolute percentage points for rates. */
  delta: number | null
  deltaKind: 'relative' | 'points'
  /** A filtered dimension this metric can't be split by: the tile shows why it has no value. */
  notApplicable: Dimension | null
  coverage: { state: 'ok' | 'partial' | 'none'; from: string | null; note: string } | null
}

export async function overview(ctx: QueryContext) {
  const { filters: f, access } = ctx
  const now = ctx.now ?? Date.now()
  const tz = access.timeZone
  const scope = scopeOf(f)
  const report = await readWatermarks(now)
  const cutoff = Math.min(f.to, now)
  const coverage = await getCoverage()
  const metrics = visibleMetrics(access).filter((m) => OVERVIEW_METRICS.includes(m.id))

  // One planner query per distinct window start (coverage can move a metric's start later).
  const memo = new Map<string, Promise<Aggregates>>()
  const agg = (from: number, to: number) => {
    const k = `${from}-${to}`
    if (!memo.has(k)) {
      memo.set(
        k,
        from >= to
          ? Promise.resolve(EMPTY_AGGREGATES)
          : windowAggregates(scope, from, to, tz, now, ctx.signal).then((rows) => (rows[0] ? toAggregates(rows[0]) : EMPTY_AGGREGATES)),
      )
    }
    return memo.get(k)!
  }

  const prevFrom = f.compare === 'none' ? null : shiftBack(f.from, f.compare, tz)
  const prevCutoff = f.compare === 'none' ? null : shiftBack(cutoff, f.compare, tz)
  // A narrowed range with too few people is hidden as a whole, in either period.
  const narrowed = f.models.length > 0 || f.features.length > 0
  const suppressed = isSmallCohort(narrowed, await agg(f.from, cutoff))
  const prevSuppressed = prevFrom !== null && isSmallCohort(narrowed, await agg(prevFrom, prevCutoff!))

  const tiles: Tile[] = await Promise.all(
    metrics.map(async (m): Promise<Tile> => {
      const cov = coverage.get(m.id)
      const covStart = cov ? Math.max(cov.collectedFrom, cov.availableFrom) : -Infinity
      const start = Math.max(f.from, covStart)
      const notApplicable = inapplicableDimension(m, f)
      const value = start < cutoff && !notApplicable && !suppressed ? m.value(await agg(start, cutoff)) : null
      let previous: number | null = null
      if (prevFrom !== null && prevCutoff !== null && !notApplicable && !suppressed && !prevSuppressed) {
        const pStart = Math.max(prevFrom, covStart)
        previous = pStart < prevCutoff ? m.value(await agg(pStart, prevCutoff)) : null
      }
      const deltaKind = m.unit === 'percent' ? 'points' : 'relative'
      const delta =
        value === null || previous === null ? null : deltaKind === 'points' ? value - previous : previous === 0 ? null : (value - previous) / previous
      return {
        id: m.id,
        label: m.label,
        unit: m.unit,
        approximate: m.approximate,
        higherIsBetter: m.higherIsBetter,
        value,
        previous,
        delta,
        deltaKind,
        notApplicable,
        coverage: cov
          ? {
              state: covStart >= cutoff ? 'none' : covStart > f.from ? 'partial' : 'ok',
              from: new Date(covStart).toISOString(),
              note: cov.note,
            }
          : null,
      }
    }),
  )

  const watermark = watermarkFor(report, ['client', 'server'])
  return {
    tiles,
    suppressed,
    minCohortUsers: config.minCohortUsers,
    window: { from: new Date(f.from).toISOString(), to: new Date(f.to).toISOString(), cutoff: new Date(cutoff).toISOString() },
    comparison: prevFrom !== null ? { from: new Date(prevFrom).toISOString(), to: new Date(prevCutoff!).toISOString() } : null,
    partial: watermark === null || cutoff > watermark,
    watermark: watermark === null ? null : new Date(watermark).toISOString(),
  }
}

// ─── Series ───────────────────────────────────────────────────────────────────

export interface SeriesBucket {
  start: string
  end: string
  key: string
  value: number | null
  /** What a drill-down of this bucket lists (events or users). */
  count: number
  /** Data after the watermark: more events are still expected. */
  partial: boolean
  /** The bucket has not ended yet. */
  open: boolean
  coverage: CoverageState
  suppressed: boolean
  lateEvents: number
  revisedAt: string | null
  previous: { start: string; value: number | null; clamped: boolean; toDate: number | null } | null
  /** An hour bucket shortened by the range edge (half-hour time zones). */
  clipped: boolean
}

export async function series(ctx: QueryContext, metricId: string) {
  const { filters: f, access } = ctx
  const metric = visibleMetric(access, metricId)
  assertApplicable(metric, f)
  const now = ctx.now ?? Date.now()
  const tz = access.timeZone
  const scope = scopeOf(f)
  const report = await readWatermarks(now)
  const watermark = watermarkFor(report, metric.streams)
  const cov = (await getCoverage()).get(metric.id)
  const buckets = bucketsFor(f.from, f.to, f.grain, tz)
  const narrowed = f.models.length > 0 || f.features.length > 0

  const current = await bucketAggregates(scope, buckets, f.grain, tz, now, ctx.signal)
  const prevBuckets = f.compare === 'none' ? null : shiftedBuckets(buckets, f, tz)
  // Month-over-month clamps Mar 29-31 onto Feb 28, so a previous bucket can serve several current ones.
  const uniquePrev = prevBuckets ? [...new Map(prevBuckets.map((b) => [b.key, b])).values()] : []
  const previous = prevBuckets ? await bucketAggregates(scope, uniquePrev, f.grain, tz, now, ctx.signal) : null
  const uses = new Map<string, number>()
  for (const b of prevBuckets ?? []) uses.set(b.key, (uses.get(b.key) ?? 0) + 1)

  const out: SeriesBucket[] = []
  for (const [i, b] of buckets.entries()) {
    const a = current.get(b.key) ?? EMPTY_AGGREGATES
    const coverage = coverageState(cov, b.start)
    const suppressed = isSmallCohort(narrowed, a)
    const open = b.end > now
    let prev: SeriesBucket['previous'] = null
    if (prevBuckets && previous) {
      const pb = prevBuckets[i]
      const pCoverage = coverageState(cov, pb.start)
      const pAgg = previous.get(pb.key) ?? EMPTY_AGGREGATES
      let toDate: number | null = null
      // The open bucket is compared with the previous period up to the same elapsed time, not with its full bucket.
      if (open && b.start < now && pCoverage === 'ok') {
        const elapsed = Math.floor((now - b.start) / MINUTE) * MINUTE
        const rows = await windowAggregates(scope, pb.start, pb.start + elapsed, tz, now, ctx.signal)
        const t = rows[0] ? toAggregates(rows[0]) : EMPTY_AGGREGATES
        toDate = isSmallCohort(narrowed, t) ? null : metric.value(t)
      }
      prev = {
        start: new Date(pb.start).toISOString(),
        // The comparison period is suppressed by the same rule: a previous-week line must not reveal a small cohort either.
        value: pCoverage === 'ok' && !isSmallCohort(narrowed, pAgg) ? metric.value(pAgg) : null,
        clamped: (uses.get(pb.key) ?? 0) > 1,
        toDate,
      }
    }
    out.push({
      start: new Date(b.start).toISOString(),
      end: new Date(b.end).toISOString(),
      key: b.key,
      value: coverage !== 'ok' || suppressed ? null : b.start >= now ? null : metric.value(a),
      count: suppressed ? 0 : metric.drillCount(a),
      partial: watermark === null || b.end > watermark,
      open,
      coverage,
      suppressed,
      lateEvents: a.late_events,
      revisedAt: a.last_revised_at,
      previous: prev,
      clipped: b.clipped ?? false,
    })
  }

  return {
    metric: metricInfo(metric),
    grain: f.grain,
    timeZone: tz,
    buckets: out,
    watermark: watermark === null ? null : new Date(watermark).toISOString(),
    coverage: cov ? { collectedFrom: new Date(cov.collectedFrom).toISOString(), availableFrom: new Date(cov.availableFrom).toISOString(), note: cov.note } : null,
  }
}

export function metricInfo(m: MetricDef) {
  return {
    id: m.id,
    label: m.label,
    unit: m.unit,
    kind: m.kind,
    approximate: m.approximate,
    higherIsBetter: m.higherIsBetter,
    streams: m.streams,
    sensitivity: m.sensitivity,
    definition: m.definition,
    drill: { counts: m.drill.counts, eventTypes: m.drill.eventTypes },
    dimensions: m.dimensions,
    dimensionNote: m.dimensionNote ?? null,
  }
}

/** p50/p95/p99 of TTFT and total time per bucket, for the latency chart. */
export async function latency(ctx: QueryContext) {
  const { filters: f, access } = ctx
  const now = ctx.now ?? Date.now()
  const tz = access.timeZone
  const report = await readWatermarks(now)
  const watermark = watermarkFor(report, ['server'])
  const buckets = bucketsFor(f.from, f.to, f.grain, tz)
  const rows = await bucketAggregates(scopeOf(f), buckets, f.grain, tz, now, ctx.signal)
  const narrowed = f.models.length > 0 || f.features.length > 0
  return {
    buckets: buckets.map((b) => {
      const a = rows.get(b.key) ?? EMPTY_AGGREGATES
      const suppressed = isSmallCohort(narrowed, a)
      const has = a.responses_ok > 0 && !suppressed
      return {
        start: new Date(b.start).toISOString(),
        end: new Date(b.end).toISOString(),
        key: b.key,
        responses: suppressed ? 0 : a.responses_ok,
        ttft: has ? a.ttft : null,
        latency: has ? a.latency : null,
        partial: watermark === null || b.end > watermark,
        open: b.end > now,
        suppressed,
      }
    }),
    watermark: watermark === null ? null : new Date(watermark).toISOString(),
  }
}

// ─── Breakdown ────────────────────────────────────────────────────────────────

export interface BreakdownRow {
  key: string
  value: number | null
  users: number
  /** Share of the metric's total (distinct users: share of all active users, i.e. adoption). */
  share: number | null
  suppressed: boolean
}

/**
 * Rows under the cohort threshold are hidden. Two or more small groups are
 * pooled into one "other" row, shown only if the pool's distinct users (merged
 * from sketches, never summed: one person can be in several groups) reach the
 * threshold. A single small group is never pooled on its own, since "other"
 * would then be that group under another name.
 */
export function partitionRows(rows: BreakdownRow[], min: number): { visible: BreakdownRow[]; small: BreakdownRow[] } {
  return { visible: rows.filter((r) => r.users >= min), small: rows.filter((r) => r.users < min) }
}

export function pooledRow(small: BreakdownRow[], pooled: { users: number; value: number | null } | null, min: number): BreakdownRow | null {
  if (small.length === 0) return null
  const show = small.length > 1 && pooled !== null && pooled.users >= min
  return {
    key: `other (${small.length})`,
    value: show ? pooled!.value : null,
    users: show ? pooled!.users : 0,
    share: null,
    suppressed: !show,
  }
}

export async function breakdown(ctx: QueryContext, metricId: string, dim: Dimension) {
  const { filters: f, access } = ctx
  const metric = visibleMetric(access, metricId)
  assertApplicable(metric, f, dim)
  const now = ctx.now ?? Date.now()
  const tz = access.timeZone
  const scope = scopeOf(f)
  const cutoff = Math.min(f.to, now)
  const cov = (await getCoverage()).get(metric.id)
  const from = cov ? Math.max(f.from, cov.collectedFrom, cov.availableFrom) : f.from
  const report = await readWatermarks(now)
  const watermark = watermarkFor(report, metric.streams)

  const [rows, totals] = await Promise.all([
    windowAggregates(scope, from, cutoff, tz, now, ctx.signal, [dim]),
    windowAggregates(scope, from, cutoff, tz, now, ctx.signal),
  ])
  const total = totals[0] ? toAggregates(totals[0]) : EMPTY_AGGREGATES
  const totalValue = metric.value(total)
  const raw: BreakdownRow[] = rows
    .map((r) => {
      const a = toAggregates(r)
      const value = metric.value(a)
      const share = metric.kind === 'distinct' || metric.kind === 'sum' ? (totalValue ? (value ?? 0) / totalValue : null) : null
      return { key: String(r[dim]), value, users: a.active_users, share, suppressed: false }
    })
    .filter((r) => r.users > 0 || (r.value ?? 0) > 0)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
  const { visible, small } = partitionRows(raw, config.minCohortUsers)
  let pooled: { users: number; value: number | null } | null = null
  if (small.length > 1) {
    const keys = small.map((r) => r.key)
    const pooledScope = dim === 'model' ? { ...scope, models: keys } : { ...scope, features: keys }
    const [row] = await windowAggregates(pooledScope, from, cutoff, tz, now, ctx.signal)
    const a = row ? toAggregates(row) : EMPTY_AGGREGATES
    pooled = { users: a.active_users, value: metric.value(a) }
  }
  const other = pooledRow(small, pooled, config.minCohortUsers)
  const safe = other ? [...visible, other] : visible

  return {
    metric: metricInfo(metric),
    dimension: dim,
    rows: safe,
    hiddenGroups: small.length,
    otherSuppressed: other?.suppressed ?? false,
    minCohortUsers: config.minCohortUsers,
    total: { value: totalValue, users: total.active_users },
    coverageFrom: cov ? new Date(from).toISOString() : null,
    partial: watermark === null || cutoff > watermark,
    watermark: watermark === null ? null : new Date(watermark).toISOString(),
  }
}

// ─── Drill-down ───────────────────────────────────────────────────────────────

interface DrillRow {
  conversation_id: string
  user_id: string
  model: string
  features: string
  platform: string
  messages: number
  tokens: number
  cost_micros: number
  max_ttft: number
  errors: string
  abandoned: number
  has_late: number
}

export async function drilldown(ctx: QueryContext, metricId: string, bucketStart: number, offset: number, limit: number) {
  const { filters: f, access } = ctx
  if (!access.permissions.includes('drilldown:read')) {
    throw new HttpError(403, 'FORBIDDEN', `Your role (${access.role}) cannot list conversations`)
  }
  const metric = visibleMetric(access, metricId)
  assertApplicable(metric, f)
  const tz = access.timeZone
  const bucket = bucketsFor(f.from, f.to, f.grain, tz).find((b) => b.start === bucketStart)
  if (!bucket) throw new HttpError(400, 'BAD_BUCKET', 'bucketStart is not a bucket of this query')
  const scope = scopeOf(f)
  const billing = access.permissions.includes('billing:read')

  // The bar's own number, from the same rollup the chart read.
  const rollup = await bucketAggregates(scope, [bucket], f.grain, tz, ctx.now ?? Date.now(), ctx.signal)
  const barAgg = rollup.get(bucket.key) ?? EMPTY_AGGREGATES

  const params: Record<string, unknown> = {}
  const where = drillWhere(scope, { grain: f.grain, day: bucket.key, start: bucket.start, end: bucket.end }, metric.drill.eventTypes, params)
  const [counts] = await chQuery<{ matched: number; users: number; conversations: number }>(
    `SELECT count() AS matched, uniqExact(user_id) AS users, uniqExact(conversation_id) AS conversations FROM events FINAL WHERE ${where}`,
    params,
    ctx.signal,
  )
  const base = {
    metric: metricInfo(metric),
    bucket: { start: new Date(bucket.start).toISOString(), end: new Date(bucket.end).toISOString(), key: bucket.key, grain: f.grain },
    rollupCount: metric.drillCount(barAgg),
    barValue: metric.value(barAgg),
    matched: Number(counts?.matched ?? 0),
    users: Number(counts?.users ?? 0),
    conversations: Number(counts?.conversations ?? 0),
    counts: metric.drill.counts,
    minCohortUsers: config.minCohortUsers,
  }
  if (base.users > 0 && base.users < config.minCohortUsers) {
    return { ...base, suppressed: true, columns: [], rows: [], offset, limit }
  }

  // 1. The page: conversations whose events are behind this bar, in the chart's own predicate.
  const order = metric.drill.orderBy === 'ttft' ? 'max_ttft DESC' : metric.drill.orderBy === 'latency' ? 'max_latency DESC' : 'first_ms DESC'
  const page = await chQuery<{ conversation_id: string; first_ms: number; matched_events: number; max_ttft: number; max_latency: number }>(
    `SELECT conversation_id, toUnixTimestamp64Milli(min(event_time)) AS first_ms, count() AS matched_events,
            max(ttft_ms) AS max_ttft, max(latency_ms) AS max_latency
       FROM events FINAL WHERE ${where}
      GROUP BY conversation_id ORDER BY ${order}, conversation_id
      LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
    { ...params, limit, offset },
    ctx.signal,
  )
  // 2. Each conversation's own totals (all of its events, not only the matched ones), metadata only.
  const ids = page.map((r) => r.conversation_id)
  const totals = ids.length
    ? await chQuery<DrillRow>(
        `SELECT conversation_id, any(user_id) AS user_id, anyIf(model, model != '') AS model,
                arrayStringConcat(arraySort(groupUniqArray(feature)), ',') AS features,
                anyIf(platform, platform != '') AS platform, countIf(event_type = 'message_sent') AS messages,
                sum(input_tokens + output_tokens) AS tokens, sum(cost_micros) AS cost_micros,
                max(ttft_ms) AS max_ttft, arrayStringConcat(arrayFilter(x -> x != '', groupUniqArray(error_code)), ',') AS errors,
                countIf(event_type = 'response_abandoned') AS abandoned, max(is_late) AS has_late
           FROM events FINAL WHERE org_id = {org:String} AND conversation_id IN {ids:Array(String)}
          GROUP BY conversation_id`,
        { org: f.org, ids },
        ctx.signal,
      )
    : []
  const byId = new Map(totals.map((t) => [t.conversation_id, t]))
  const rows = page.map((p) => ({ ...byId.get(p.conversation_id)!, first_ms: p.first_ms, matched_events: p.matched_events }))
  const columns = ['conversation', 'user', 'firstEventAt', 'model', 'features', 'platform', 'matchedEvents', 'messages', 'tokens', ...(billing ? ['costUsd'] : []), 'maxTtftMs', 'errors', 'late']
  return {
    ...base,
    suppressed: false,
    columns,
    offset,
    limit,
    rows: rows.map((r) => ({
      conversation: r.conversation_id,
      user: r.user_id,
      firstEventAt: new Date(Number(r.first_ms)).toISOString(),
      model: r.model,
      features: r.features ? r.features.split(',') : [],
      platform: r.platform || null,
      matchedEvents: Number(r.matched_events),
      messages: Number(r.messages),
      tokens: Number(r.tokens),
      ...(billing ? { costUsd: Number(r.cost_micros) / 1_000_000 } : {}),
      maxTtftMs: Number(r.max_ttft) || null,
      errors: r.errors ? r.errors.split(',') : [],
      late: Number(r.has_late) === 1,
    })),
  }
}
