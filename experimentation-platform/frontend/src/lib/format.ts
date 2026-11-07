import { BUCKETS } from '@exp/core'

/** Buckets → "12.5%". */
export function pctBuckets(buckets: number, digits = 2): string {
  const v = (buckets / BUCKETS) * 100
  return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(digits)}%`
}

/** Fraction → "12.5%". */
export function pct(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`
}

export function signedPct(fraction: number | null, digits = 1): string {
  if (fraction === null || !Number.isFinite(fraction)) return '—'
  const s = (fraction * 100).toFixed(digits)
  return fraction > 0 ? `+${s}%` : `${s}%`
}

export function pValue(p: number): string {
  if (p < 0.0001) return p.toExponential(1)
  return p.toFixed(4)
}

export function num(n: number): string {
  return n.toLocaleString('en-US')
}

export function timeAgo(iso: string | number | null): string {
  if (iso === null) return '—'
  const ms = Date.now() - (typeof iso === 'number' ? iso : new Date(iso).getTime())
  if (ms < 5_000) return 'just now'
  if (ms < 60_000) return `${Math.round(ms / 1000)} s ago`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`
  return `${Math.round(ms / 86_400_000)} d ago`
}

export function dateTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** Stable colors per variant position (control first). */
export const VARIANT_COLORS = ['bg-slate-400', 'bg-accent-500', 'bg-emerald-500', 'bg-amber-500', 'bg-sky-500', 'bg-fuchsia-500']
export const VARIANT_TEXT = ['text-slate-600', 'text-accent-700', 'text-emerald-700', 'text-amber-700', 'text-sky-700', 'text-fuchsia-700']
