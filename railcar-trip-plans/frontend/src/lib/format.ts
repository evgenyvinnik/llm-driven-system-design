/** Times are shown in UTC (the railroad's network clock here), relative ages against the server's clock. */
import { useClockStore } from '@/stores/clock-store'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

export function fmtShort(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${DAYS[d.getUTCDay()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

export function fmtClock(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`
}

export function hoursBetween(a: string, b: string): number {
  return (Date.parse(a) - Date.parse(b)) / 3_600_000
}

export function fmtHours(h: number): string {
  const sign = h > 0 ? '+' : h < 0 ? '−' : ''
  const abs = Math.abs(h)
  return abs >= 48 ? `${sign}${(abs / 24).toFixed(1)} d` : `${sign}${abs.toFixed(abs < 10 ? 1 : 0)} h`
}

/** "in 6 h" / "3 h ago", against the domain clock. */
export function relative(iso: string | null | undefined, nowIso: string): string {
  if (!iso) return '—'
  const h = hoursBetween(iso, nowIso)
  const abs = Math.abs(h)
  const text = abs < 1 ? `${Math.round(abs * 60)} min` : abs < 48 ? `${abs.toFixed(abs < 10 ? 1 : 0)} h` : `${(abs / 24).toFixed(1)} d`
  return h >= 0 ? `in ${text}` : `${text} ago`
}

export function useNow(): string {
  return useClockStore((s) => s.now)
}

export function fmtLag(minutes: number): string {
  if (minutes < 1) return '<1 min'
  if (minutes < 120) return `${minutes} min`
  return `${(minutes / 60).toFixed(minutes < 600 ? 1 : 0)} h`
}

export const label = (s: string) => s.replace(/_/g, ' ')
