/**
 * Number and time formatting. Times are always shown in the org's time zone,
 * labelled, because "yesterday" means the org's yesterday.
 */
import { DateTime } from 'luxon'
import type { Grain } from './filters'
import type { Unit } from './api'

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const whole = new Intl.NumberFormat('en-US')

export function formatValue(value: number | null | undefined, unit: Unit, opts: { compact?: boolean } = {}): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  switch (unit) {
    case 'percent':
      return `${(value * 100).toFixed(value < 0.1 ? 2 : 1)}%`
    case 'ms':
      return value >= 10_000 ? `${(value / 1000).toFixed(1)} s` : `${whole.format(Math.round(value))} ms`
    case 'usd':
      return value < 1 ? `$${value.toFixed(3)}` : value >= 10_000 ? `$${compact.format(value)}` : `$${value.toFixed(2)}`
    case 'tokens':
    case 'count':
      return opts.compact && value >= 10_000 ? compact.format(value) : whole.format(Math.round(value * 10) / 10)
  }
}

export function formatAxis(value: number, unit: Unit): string {
  if (unit === 'percent') return `${Math.round(value * 1000) / 10}%`
  if (unit === 'ms') return value >= 1000 ? `${Math.round(value / 100) / 10}s` : `${Math.round(value)}ms`
  if (unit === 'usd') return `$${value >= 1000 ? compact.format(value) : Math.round(value * 100) / 100}`
  return value >= 1000 ? compact.format(value) : String(Math.round(value * 10) / 10)
}

export function formatDelta(delta: number | null, kind: 'relative' | 'points'): string {
  if (delta === null) return '—'
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±'
  const abs = Math.abs(delta)
  return kind === 'points' ? `${sign}${(abs * 100).toFixed(2)} pts` : `${sign}${(abs * 100).toFixed(1)}%`
}

export function bucketLabel(startIso: string, grain: Grain, timeZone: string, short = false): string {
  const d = DateTime.fromISO(startIso, { zone: timeZone })
  if (grain === 'day') return short ? d.toFormat('MMM d') : d.toFormat('ccc, MMM d')
  if (grain === 'hour') return short ? d.toFormat('HH:mm') : d.toFormat('ccc MMM d, HH:mm')
  return d.toFormat('HH:mm')
}

export function localTime(iso: string | null | undefined, timeZone: string, fmt = 'MMM d, HH:mm'): string {
  if (!iso) return '—'
  return DateTime.fromISO(iso, { zone: timeZone }).toFormat(fmt)
}

export function zoneAbbrev(timeZone: string, at = Date.now()): string {
  return DateTime.fromMillis(at, { zone: timeZone }).toFormat('ZZZZ')
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'unknown'
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 90) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 90) return `${m} min`
  const h = Math.round(m / 60)
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`
}

export const FEATURE_LABELS: Record<string, string> = {
  chat: 'Plain chat',
  web_search: 'Web search',
  code_execution: 'Code execution',
  file_analysis: 'File analysis',
  image_input: 'Image input',
}
