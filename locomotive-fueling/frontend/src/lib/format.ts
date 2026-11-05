export const money = (n: number | null | undefined, digits = 0) =>
  n === null || n === undefined ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: digits, minimumFractionDigits: digits })

export const gal = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${Math.round(n).toLocaleString('en-US')} gal`)

export const num = (n: number | null | undefined, digits = 0) => (n === null || n === undefined ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }))

/** Simulated wall-clock time, e.g. "Fri 14:05". */
export function simTime(ms: number | string | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  const d = new Date(ms)
  return d.toLocaleString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' })
}

/** "in 3.2 h", "12 min ago" relative to the simulated now. */
export function relHours(ms: number, nowMs: number): string {
  const h = (ms - nowMs) / 3_600_000
  const abs = Math.abs(h)
  const text = abs < 1 ? `${Math.round(abs * 60)} min` : `${abs.toFixed(1)} h`
  return h >= 0 ? `in ${text}` : `${text} ago`
}

export function ageLabel(ms: number | null, nowMs: number): string {
  if (!ms) return 'no data'
  const min = (nowMs - ms) / 60_000
  if (min < 15) return 'live'
  return min < 90 ? `${Math.round(min)} min old` : `${(min / 60).toFixed(1)} h old`
}

export const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
