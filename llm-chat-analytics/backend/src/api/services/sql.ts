/**
 * SQL builders. `filterClause` is the single predicate for org, model and
 * feature: rollup reads, raw-event edges, drill-downs and exports all call it,
 * which is what "the drill-down runs exactly the same query" means in code.
 * @module api/services/sql
 */
import type { EventType } from '../../shared/contract.js'
import { toChDateTime } from '../../shared/time.js'
import type { Aggregates } from './catalog.js'
import type { Piece } from './planner.js'

export interface Scope {
  org: string
  models: string[]
  features: string[]
}

type Params = Record<string, unknown>

const SUMS = [
  'conversations',
  'messages',
  'responses_ok',
  'responses_failed',
  'responses_abandoned',
  'input_tokens',
  'output_tokens',
  'cost_micros',
  'late_events',
] as const

export function filterClause(scope: Scope, params: Params): string {
  params.org = scope.org
  const parts = ['org_id = {org:String}']
  if (scope.models.length) {
    params.models = scope.models
    parts.push('model IN {models:Array(String)}')
  }
  if (scope.features.length) {
    params.features = scope.features
    parts.push('feature IN {features:Array(String)}')
  }
  return parts.join(' AND ')
}

/** Merge expressions over rollup columns or over a union of states. */
export const MERGED = [
  ...SUMS.map((c) => `sum(${c}) AS ${c}`),
  'max(last_revised_at) AS last_revised_at',
  'uniqCombined64Merge(active_users) AS active_users',
  'quantilesTDigestMerge(0.5, 0.95, 0.99)(ttft) AS ttft',
  'quantilesTDigestMerge(0.5, 0.95, 0.99)(latency) AS latency',
].join(',\n  ')

function rollupStates(dims: string[]): string {
  return [
    ...dims,
    ...SUMS.map((c) => `toUInt64(${c}) AS ${c}`),
    "toDateTime64(last_revised_at, 3, 'UTC') AS last_revised_at",
    'active_users',
    'ttft',
    'latency',
  ].join(', ')
}

/** The same states the materialized views compute, built on the fly from raw events. */
function rawStates(dims: string[]): string {
  return [
    ...dims,
    "toUInt64(countIf(event_type = 'conversation_started')) AS conversations",
    "toUInt64(countIf(event_type = 'message_sent')) AS messages",
    "toUInt64(countIf(event_type = 'response_completed')) AS responses_ok",
    "toUInt64(countIf(event_type = 'response_failed')) AS responses_failed",
    "toUInt64(countIf(event_type = 'response_abandoned')) AS responses_abandoned",
    'toUInt64(sum(input_tokens)) AS input_tokens',
    'toUInt64(sum(output_tokens)) AS output_tokens',
    'toUInt64(sum(cost_micros)) AS cost_micros',
    'toUInt64(countIf(is_late = 1)) AS late_events',
    'maxIf(ingested_at, is_late = 1) AS last_revised_at',
    "uniqCombined64StateIf(user_id, event_type = 'message_sent') AS active_users",
    "quantilesTDigestStateIf(0.5, 0.95, 0.99)(ttft_ms, event_type = 'response_completed') AS ttft",
    "quantilesTDigestStateIf(0.5, 0.95, 0.99)(latency_ms, event_type = 'response_completed') AS latency",
  ].join(', ')
}

/** One query that merges every planned piece of a window, optionally grouped by dimensions. */
export function windowSql(pieces: Piece[], scope: Scope, dims: string[]): { sql: string; params: Params } {
  const params: Params = {}
  const filter = filterClause(scope, params)
  const groupBy = dims.length ? `GROUP BY ${dims.join(', ')}` : ''
  const parts = pieces.map((piece, i) => {
    const p = `p${i}`
    switch (piece.source) {
      case 'day':
        params[`${p}_from`] = piece.fromDate
        params[`${p}_to`] = piece.toDate
        return `SELECT ${rollupStates(dims)} FROM rollup_day_local WHERE ${filter} AND local_date >= {${p}_from:Date} AND local_date < {${p}_to:Date}`
      case 'hour':
      case 'minute':
        params[`${p}_from`] = toChDateTime(piece.from)
        params[`${p}_to`] = toChDateTime(piece.to)
        return `SELECT ${rollupStates(dims)} FROM rollup_${piece.source} WHERE ${filter} AND bucket >= {${p}_from:DateTime('UTC')} AND bucket < {${p}_to:DateTime('UTC')}`
      case 'raw':
        params[`${p}_from`] = piece.from / 1000
        params[`${p}_to`] = piece.to / 1000
        return `SELECT ${rawStates(dims)} FROM events FINAL WHERE ${filter} AND event_time >= toDateTime64({${p}_from:Float64}, 3, 'UTC') AND event_time < toDateTime64({${p}_to:Float64}, 3, 'UTC') ${groupBy}`
    }
  })
  const sql = `SELECT ${[...dims, MERGED].join(', ')} FROM (\n${parts.join('\nUNION ALL\n')}\n) ${groupBy}`
  return { sql, params }
}

/** Rollup rows per bucket for a chart. Day buckets are org-local dates; others are UTC instants. */
export function seriesSql(grain: 'minute' | 'hour' | 'day', from: number | string, to: number | string, scope: Scope): { sql: string; params: Params } {
  const params: Params = {}
  const filter = filterClause(scope, params)
  if (grain === 'day') {
    params.from = from
    params.to = to
    return {
      sql: `SELECT toString(local_date) AS k, ${MERGED} FROM rollup_day_local WHERE ${filter} AND local_date >= {from:Date} AND local_date < {to:Date} GROUP BY k`,
      params,
    }
  }
  params.from = toChDateTime(from as number)
  params.to = toChDateTime(to as number)
  return {
    sql: `SELECT toString(bucket) AS k, ${MERGED} FROM rollup_${grain} WHERE ${filter} AND bucket >= {from:DateTime('UTC')} AND bucket < {to:DateTime('UTC')} GROUP BY k`,
    params,
  }
}

export interface BucketScope {
  grain: 'minute' | 'hour' | 'day'
  /** Local date for day buckets. */
  day?: string
  start: number
  end: number
}

/** Raw-event predicate for one chart bucket, bucketed exactly the way the rollup bucketed it. */
export function drillWhere(scope: Scope, bucket: BucketScope, eventTypes: EventType[], params: Params): string {
  const filter = filterClause(scope, params)
  params.types = eventTypes
  let time: string
  if (bucket.grain === 'day') {
    params.day = bucket.day
    time = 'local_date = {day:Date}'
  } else {
    params.bs = bucket.start / 1000
    params.be = bucket.end / 1000
    time = "event_time >= toDateTime64({bs:Float64}, 3, 'UTC') AND event_time < toDateTime64({be:Float64}, 3, 'UTC')"
  }
  return `${filter} AND event_type IN {types:Array(String)} AND ${time}`
}

export interface AggregateRow {
  k?: string
  model?: string
  feature?: string
  conversations: number
  messages: number
  responses_ok: number
  responses_failed: number
  responses_abandoned: number
  input_tokens: number
  output_tokens: number
  cost_micros: number
  late_events: number
  last_revised_at: string
  active_users: number
  ttft: (number | null)[]
  latency: (number | null)[]
}

const quantiles = (q: (number | null)[] | undefined): [number, number, number] => [
  Math.round(q?.[0] ?? 0),
  Math.round(q?.[1] ?? 0),
  Math.round(q?.[2] ?? 0),
]

export function toAggregates(row: AggregateRow): Aggregates {
  const revised = row.last_revised_at && !row.last_revised_at.startsWith('1970') ? row.last_revised_at.replace(' ', 'T') + 'Z' : null
  return {
    conversations: Number(row.conversations),
    messages: Number(row.messages),
    responses_ok: Number(row.responses_ok),
    responses_failed: Number(row.responses_failed),
    responses_abandoned: Number(row.responses_abandoned),
    input_tokens: Number(row.input_tokens),
    output_tokens: Number(row.output_tokens),
    cost_micros: Number(row.cost_micros),
    late_events: Number(row.late_events),
    last_revised_at: revised,
    active_users: Number(row.active_users),
    ttft: quantiles(row.ttft),
    latency: quantiles(row.latency),
  }
}
