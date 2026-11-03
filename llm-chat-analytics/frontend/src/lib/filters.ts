/**
 * Dashboard filters. The URL is the source of truth: every filter lives in the
 * search string, so a refresh, the back button or a pasted link reproduces the
 * exact view. Components never keep their own copy.
 *
 * The URL keeps the user's intent ("last 7 days"); `resolveQuery` turns it into
 * absolute, bucket-aligned instants in the org's time zone. The resolved query
 * is what gets fetched, cached and echoed, so a drill-down or an export started
 * from a chart asks exactly the question the chart asked.
 */
import { DateTime } from 'luxon'

export const RANGES = ['1h', 'today', '24h', '7d', '28d', 'mtd', 'custom'] as const
export const COMPARES = ['none', 'wow', 'mom'] as const
export const GRAINS = ['minute', 'hour', 'day'] as const
export const FEATURES = ['chat', 'web_search', 'code_execution', 'file_analysis', 'image_input'] as const

export type Range = (typeof RANGES)[number]
export type Compare = (typeof COMPARES)[number]
export type Grain = (typeof GRAINS)[number]

/** What the URL holds. */
export interface DashboardSearch {
  org?: string
  range: Range
  from?: string
  to?: string
  grain?: Grain
  compare: Compare
  models: string[]
  features: string[]
  metric: string
  /** Bucket start (ISO) of the bar whose conversations are open in the drill-down. */
  drill?: string
}

/** What gets fetched: absolute and aligned. */
export interface ResolvedQuery {
  org: string
  from: string
  to: string
  grain: Grain
  models: string[]
  features: string[]
  compare: Compare
}

const list = (v: unknown): string[] => {
  const raw = Array.isArray(v) ? v.join(',') : typeof v === 'string' ? v : ''
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))].sort()
}

const oneOf = <T extends readonly string[]>(values: T, v: unknown, fallback: T[number]): T[number] =>
  typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T[number]) : fallback

const isoDate = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined)

/** Parses untrusted search params. Unknown values fall back to defaults instead of breaking the page. */
export function parseSearch(raw: Record<string, unknown>): DashboardSearch {
  return {
    org: typeof raw.org === 'string' && raw.org ? raw.org : undefined,
    range: oneOf(RANGES, raw.range, '7d'),
    from: isoDate(raw.from),
    to: isoDate(raw.to),
    grain: typeof raw.grain === 'string' ? oneOf(GRAINS, raw.grain, 'day') : undefined,
    compare: oneOf(COMPARES, raw.compare, 'wow'),
    models: list(raw.models),
    features: list(raw.features).filter((f) => (FEATURES as readonly string[]).includes(f)),
    metric: typeof raw.metric === 'string' && raw.metric ? raw.metric : 'conversations',
    drill: typeof raw.drill === 'string' && !Number.isNaN(Date.parse(raw.drill)) ? raw.drill : undefined,
  }
}

/** Search params as they should appear in the URL: defaults and empty lists dropped, lists comma-joined. */
export function toUrlSearch(s: DashboardSearch): Record<string, string | undefined> {
  return {
    org: s.org,
    range: s.range === '7d' ? undefined : s.range,
    from: s.range === 'custom' ? s.from : undefined,
    to: s.range === 'custom' ? s.to : undefined,
    grain: s.grain,
    compare: s.compare === 'wow' ? undefined : s.compare,
    models: s.models.length ? s.models.join(',') : undefined,
    features: s.features.length ? s.features.join(',') : undefined,
    metric: s.metric === 'conversations' ? undefined : s.metric,
    drill: s.drill,
  }
}

const DEFAULT_GRAIN: Record<Range, Grain> = { '1h': 'minute', today: 'hour', '24h': 'hour', '7d': 'day', '28d': 'day', mtd: 'day', custom: 'day' }

/** Grains that make sense for a span: not 10,000 minute buckets, not one day bucket for an hour. */
export function allowedGrains(fromMs: number, toMs: number): Grain[] {
  const hours = (toMs - fromMs) / 3_600_000
  const out: Grain[] = []
  if (hours <= 48) out.push('minute')
  if (hours <= 35 * 24) out.push('hour')
  if (hours >= 24) out.push('day')
  return out
}

/**
 * Turns "last 7 days in this org" into instants. `now` is passed in, so the
 * result only changes when a boundary is crossed: "7d" changes at the org's
 * midnight, "24h" on the hour, "1h" on the minute. Between those moments the
 * query, and therefore the cache key, is stable.
 */
export function resolveQuery(s: DashboardSearch, org: string, timeZone: string, now: number): ResolvedQuery {
  const local = DateTime.fromMillis(now, { zone: timeZone })
  const today = local.startOf('day')
  let from: DateTime
  let to: DateTime
  switch (s.range) {
    case '1h':
      to = local.startOf('minute').plus({ minutes: 1 })
      from = to.minus({ hours: 1 })
      break
    case 'today':
      from = today
      to = today.plus({ days: 1 })
      break
    case '24h':
      to = local.startOf('hour').plus({ hours: 1 })
      from = to.minus({ hours: 24 })
      break
    case '28d':
      from = today.minus({ days: 27 })
      to = today.plus({ days: 1 })
      break
    case 'mtd':
      from = local.startOf('month')
      to = today.plus({ days: 1 })
      break
    case 'custom': {
      const a = s.from ? DateTime.fromISO(s.from, { zone: timeZone }) : today.minus({ days: 6 })
      const b = s.to ? DateTime.fromISO(s.to, { zone: timeZone }) : today
      from = (a <= b ? a : b).startOf('day')
      to = (a <= b ? b : a).startOf('day').plus({ days: 1 })
      break
    }
    default:
      from = today.minus({ days: 6 })
      to = today.plus({ days: 1 })
  }
  const allowed = allowedGrains(from.toMillis(), to.toMillis())
  let grain = s.grain && allowed.includes(s.grain) ? s.grain : DEFAULT_GRAIN[s.range]
  if (!allowed.includes(grain)) grain = allowed[allowed.length - 1]
  // Hour and minute buckets are UTC-aligned; a day range always starts at local midnight.
  return {
    org,
    from: from.toUTC().toISO()!,
    to: to.toUTC().toISO()!,
    grain,
    models: [...s.models].sort(),
    features: [...s.features].sort(),
    compare: s.compare,
  }
}

/**
 * The canonical string, built exactly like the server's: fixed key order,
 * sorted lists, empty values dropped. The server echoes it back; a response
 * whose echo differs from what this widget is showing now is discarded.
 */
export function canonicalString(q: ResolvedQuery, extra: Record<string, string | number | undefined> = {}): string {
  const iso = (s: string) => new Date(s).toISOString()
  const parts: [string, string][] = [
    ['org', q.org],
    ['from', iso(q.from)],
    ['to', iso(q.to)],
    ['grain', q.grain],
    ['models', q.models.join(',')],
    ['features', q.features.join(',')],
    ['compare', q.compare],
  ]
  for (const k of Object.keys(extra).sort()) {
    const v = extra[k]
    if (v !== undefined && v !== '') parts.push([k, String(v)])
  }
  return parts
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
}

/** Query-string params for a request. */
export function toParams(q: ResolvedQuery, extra: Record<string, string | number | undefined> = {}): URLSearchParams {
  const p = new URLSearchParams({ org: q.org, from: new Date(q.from).toISOString(), to: new Date(q.to).toISOString(), grain: q.grain, compare: q.compare })
  if (q.models.length) p.set('models', q.models.join(','))
  if (q.features.length) p.set('features', q.features.join(','))
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== '') p.set(k, String(v))
  return p
}

export type Dimension = 'model' | 'feature'

/**
 * Cross-filtering: a breakdown chart is filtered by every selection except its
 * own dimension, so the model chart keeps showing all models (with the chosen
 * ones highlighted) while every other widget narrows to them.
 */
export function withoutDimension(q: ResolvedQuery, dim: Dimension): ResolvedQuery {
  return dim === 'model' ? { ...q, models: [] } : { ...q, features: [] }
}

export function toggle(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value].sort()
}
