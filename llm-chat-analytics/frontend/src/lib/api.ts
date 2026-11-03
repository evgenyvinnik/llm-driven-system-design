/**
 * HTTP client. Every request takes an AbortSignal: when a widget's filters
 * change, TanStack Query aborts the superseded request, the browser closes the
 * connection, and the API stops the ClickHouse query behind it.
 */
import type { Grain } from './filters'

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

/** Thrown when a response answers a different question than the one on screen. Never painted. */
export class StaleResponseError extends Error {
  constructor(expected: string, got: string) {
    super(`Discarded a response for "${got}" while showing "${expected}"`)
  }
}

export async function api<T>(path: string, init: RequestInit & { signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  })
  if (res.status === 204) return undefined as T
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    throw new ApiError(res.status, body?.error?.code ?? 'HTTP_ERROR', body?.error?.message ?? `Request failed (${res.status})`)
  }
  return body as T
}

/** GET a widget query and verify the server's echo matches what was asked. */
export async function queryWidget<T extends { echo: string }>(widget: string, params: URLSearchParams, expectedEcho: string, signal?: AbortSignal): Promise<T> {
  const data = await api<T>(`/query/${widget}?${params}`, { signal })
  if (data.echo !== expectedEcho) throw new StaleResponseError(expectedEcho, data.echo)
  return data
}

// ─── Response types ─────────────────────────────────────────────────────────

export type Unit = 'count' | 'percent' | 'ms' | 'usd' | 'tokens'
export type Permission = 'metrics:read' | 'billing:read' | 'drilldown:read' | 'export:create'

export interface OrgAccess {
  orgId: string
  orgName: string
  timeZone: string
  role: 'admin' | 'analyst' | 'support'
  permissions: Permission[]
}

export interface User {
  id: string
  username: string
  displayName: string
  isStaff: boolean
}

export interface MetricInfo {
  id: string
  label: string
  unit: Unit
  kind: 'sum' | 'ratio' | 'distinct' | 'percentile'
  approximate: boolean
  higherIsBetter: boolean | null
  streams: ('client' | 'server')[]
  sensitivity: 'standard' | 'billing'
  definition: string
  drill: { counts: 'events' | 'users'; eventTypes: string[] }
  /** Dimensions the metric can be filtered or broken down by. */
  dimensions: ('model' | 'feature')[]
  dimensionNote: string | null
  coverage?: { collectedFrom: string; availableFrom: string; note: string } | null
}

export interface Meta {
  metrics: MetricInfo[]
  dimensions: { model: string[]; feature: string[] }
  eventTypes: string[]
  eventContract: { field: string; optional: boolean }[]
  forbiddenKeys: string[]
  minCohortUsers: number
  latenessAllowanceMs: { client: number; server: number }
  maxLatenessHours: number
}

export interface Tile {
  id: string
  label: string
  unit: Unit
  approximate: boolean
  higherIsBetter: boolean | null
  value: number | null
  previous: number | null
  delta: number | null
  deltaKind: 'relative' | 'points'
  notApplicable: 'model' | 'feature' | null
  coverage: { state: 'ok' | 'partial' | 'none'; from: string | null; note: string } | null
}

export interface OverviewResponse {
  echo: string
  tiles: Tile[]
  /** A narrowed range with fewer than minCohortUsers people: every tile is hidden. */
  suppressed: boolean
  minCohortUsers: number
  window: { from: string; to: string; cutoff: string }
  comparison: { from: string; to: string } | null
  partial: boolean
  watermark: string | null
}

export type CoverageState = 'ok' | 'not_collected' | 'backfill_pending'

export interface SeriesBucket {
  start: string
  end: string
  key: string
  value: number | null
  count: number
  partial: boolean
  open: boolean
  coverage: CoverageState
  suppressed: boolean
  lateEvents: number
  revisedAt: string | null
  previous: { start: string; value: number | null; clamped: boolean; toDate: number | null } | null
  clipped: boolean
}

export interface SeriesResponse {
  echo: string
  metric: MetricInfo
  grain: Grain
  timeZone: string
  buckets: SeriesBucket[]
  watermark: string | null
  coverage: { collectedFrom: string; availableFrom: string; note: string } | null
}

export interface LatencyResponse {
  echo: string
  buckets: {
    start: string
    end: string
    key: string
    responses: number
    ttft: [number, number, number] | null
    latency: [number, number, number] | null
    partial: boolean
    open: boolean
    suppressed: boolean
  }[]
  watermark: string | null
}

export interface BreakdownRow {
  key: string
  value: number | null
  users: number
  share: number | null
  suppressed: boolean
}

export interface BreakdownResponse {
  echo: string
  metric: MetricInfo
  dimension: 'model' | 'feature'
  rows: BreakdownRow[]
  hiddenGroups: number
  otherSuppressed: boolean
  minCohortUsers: number
  total: { value: number | null; users: number }
  coverageFrom: string | null
  partial: boolean
  watermark: string | null
}

export interface DrillRow {
  conversation: string
  user: string
  firstEventAt: string
  model: string
  features: string[]
  platform: string | null
  /** Events of this conversation that are behind the bar. */
  matchedEvents: number
  /** The conversation's own totals. */
  messages: number
  tokens: number
  costUsd?: number
  maxTtftMs: number | null
  errors: string[]
  late: boolean
}

export interface DrilldownResponse {
  echo: string
  metric: MetricInfo
  bucket: { start: string; end: string; key: string; grain: Grain }
  rollupCount: number
  barValue: number | null
  matched: number
  users: number
  conversations: number
  counts: 'events' | 'users'
  minCohortUsers: number
  suppressed: boolean
  columns: string[]
  rows: DrillRow[]
  offset: number
  limit: number
}

export interface FreshnessResponse {
  now: string
  timeZone: string
  processedThrough: string | null
  watermarks: { client: string | null; server: string | null }
  allowanceMs: { client: number; server: number }
  maxLatenessHours: number
  backlog: number
  stalledPartitions: number[]
  missingPartitions: number[]
  days: { localDate: string; events: number; lateEvents: number; lastRevisedAt: string | null }[]
}

export interface PipelineResponse {
  now: string
  partitions: { partition: number; position: string; updatedAt: string; lag: number; stalled: boolean }[]
  processedThrough: string | null
  watermarks: { client: string | null; server: string | null }
  missingPartitions: number[]
  counters: Record<string, number>
  rejected: { reason: string; count: number; lastAt: string; sampleDetail: string }[]
  ingestedPerMinute: { minute: string; rows: number; late: number }[]
}

export type ExportStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'expired'

export interface ExportJob {
  id: string
  org: string
  kind: 'daily_metrics' | 'conversations'
  query: Record<string, string>
  columns: string[]
  status: ExportStatus
  rowsTotal: number | null
  rowsDone: number
  fileBytes: number | null
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  expiresAt: string | null
}
