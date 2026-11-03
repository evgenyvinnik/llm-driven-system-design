/**
 * The canonical dashboard query. Every widget request, the drill-down and the
 * export carry the same object. Canonicalizing it (sorted, de-duplicated,
 * defaults removed) gives one string per distinct question, which is both the
 * cache key and the echo the client uses to drop responses it no longer wants.
 * @module api/services/query-spec
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEATURES } from '../../shared/contract.js'
import { HttpError } from '../../shared/errors.js'
import { DAY, HOUR, isAligned, type Compare, type Grain } from '../../shared/time.js'
import { DIMENSIONS, type Dimension } from './catalog.js'

const csv = (values?: readonly string[]) =>
  z
    .string()
    .optional()
    .transform((s) => [...new Set((s ?? '').split(',').map((v) => v.trim()).filter(Boolean))].sort())
    .pipe(values ? z.array(z.enum(values as [string, ...string[]])) : z.array(z.string().max(64)))

const instant = z
  .string()
  .datetime({ offset: true })
  .transform((s) => Date.parse(s))

export const filtersSchema = z.object({
  org: z.string().min(1).max(64),
  from: instant,
  to: instant,
  grain: z.enum(['minute', 'hour', 'day']),
  models: csv(),
  features: csv(FEATURES),
  compare: z.enum(['none', 'wow', 'mom']).default('none'),
})

export interface Filters {
  org: string
  from: number
  to: number
  grain: Grain
  models: string[]
  features: string[]
  compare: Compare
}

const MAX_BUCKETS = 1500
const MAX_SPAN: Record<Grain, number> = { minute: 2 * DAY, hour: 35 * DAY, day: 400 * DAY }

/** Parses and validates query-string filters against the org's time zone. */
export function parseFilters(query: Record<string, unknown>, timeZone: string): Filters {
  const f = filtersSchema.parse(query) as Filters
  if (f.to <= f.from) throw new HttpError(400, 'BAD_RANGE', '`to` must be after `from`')
  if (f.to - f.from > MAX_SPAN[f.grain]) throw new HttpError(400, 'RANGE_TOO_LONG', `A ${f.grain} chart covers at most ${MAX_SPAN[f.grain] / DAY} days`)
  const step = f.grain === 'minute' ? 60_000 : f.grain === 'hour' ? HOUR : DAY
  if ((f.to - f.from) / step > MAX_BUCKETS) throw new HttpError(400, 'TOO_MANY_BUCKETS', `At most ${MAX_BUCKETS} buckets`)
  if (!isAligned(f.from, f.grain, timeZone) || !isAligned(f.to, f.grain, timeZone)) {
    throw new HttpError(400, 'UNALIGNED_RANGE', `from and to must fall on ${f.grain} boundaries in ${timeZone}`)
  }
  return f
}

export const dimensionSchema = z.enum(DIMENSIONS)
export type { Dimension }

/** Stable string for a filters object plus widget-specific extras. Key order is fixed. */
export function canonicalString(f: Filters, extra: Record<string, string | number | undefined> = {}): string {
  const parts: [string, string][] = [
    ['org', f.org],
    ['from', new Date(f.from).toISOString()],
    ['to', new Date(f.to).toISOString()],
    ['grain', f.grain],
    ['models', f.models.join(',')],
    ['features', f.features.join(',')],
    ['compare', f.compare],
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

/**
 * Server cache key. Beyond the canonical query it includes the caller's
 * permission scope (an admin's cached response carries cost; an analyst must
 * never be served it) and the org's revision counter (bumped when late events
 * land, so cached past windows go stale exactly when their numbers change).
 */
export function cacheKey(widget: string, canonical: string, scope: string, revision: string): string {
  return createHash('sha1').update(`${widget}|${canonical}|${scope}|rev=${revision}`).digest('hex')
}
