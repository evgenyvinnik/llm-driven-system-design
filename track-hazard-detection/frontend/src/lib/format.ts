import type { HazardKind, Severity } from '@/types'

export const humanize = (s: string | null | undefined) => (s ? s.replace(/_/g, ' ') : '—')

export const KIND_LABEL: Record<HazardKind, string> = {
  rockfall: 'Rockfall',
  obstruction: 'Obstruction',
  high_water: 'High water',
  rail_buckling_risk: 'Heat / buckling risk',
}

export const mpText = (from: number, to: number) => (Math.abs(from - to) < 0.05 ? `MP ${from.toFixed(1)}` : `MP ${from.toFixed(1)}–${to.toFixed(1)}`)

export function ageText(fromIso: string | null | undefined, nowMs: number): string {
  if (!fromIso) return '—'
  const s = Math.max(0, Math.round((nowMs - new Date(fromIso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h ${m % 60} min ago`
  return `${Math.floor(h / 24)} d ago`
}

export function timeText(iso: string | null | undefined, seconds = true): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: seconds ? '2-digit' : undefined })
}

export function dateTimeText(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function msText(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
}

export function secondsText(s: number | null | undefined): string {
  if (s === null || s === undefined) return '—'
  return msText(s * 1000)
}

/** "ack due in 0:42" / "overdue 1:05" against the server clock offset. */
export function countdown(iso: string, nowMs: number): { text: string; overdue: boolean } {
  const diff = Math.round((new Date(iso).getTime() - nowMs) / 1000)
  const abs = Math.abs(diff)
  const t = `${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}`
  return diff >= 0 ? { text: `due in ${t}`, overdue: false } : { text: `overdue ${t}`, overdue: true }
}

export const SEVERITY_ORDER: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
export const severityRank = (s: Severity) => 3 - SEVERITY_ORDER.indexOf(s)

export const shortId = (id: string) => id.slice(0, 8)
