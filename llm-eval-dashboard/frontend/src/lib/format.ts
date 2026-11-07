/** Display helpers. Text, never colour alone, carries the meaning. */

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return '—'
  const s = Math.round((now - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${Math.max(0, s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function duration(from: string | null, to: string | null): string {
  if (!from) return '—'
  const s = Math.round(((to ? new Date(to).getTime() : Date.now()) - new Date(from).getTime()) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

export function ms(v: number | null): string {
  if (v === null || v === undefined) return '—'
  return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`
}

/** A score in [0, 1] shown to 3 decimals. */
export function score(v: number | null | undefined): string {
  return v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(3)
}

export function signed(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(3)}`
}

export function ci(range: [number, number] | null | undefined, sign = false): string {
  if (!range) return 'no interval'
  const f = sign ? signed : score
  return `[${f(range[0])}, ${f(range[1])}]`
}

export function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `${Math.round(v * 1000) / 10}%`
}

export function num(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : v.toLocaleString()
}

export function newIdempotencyKey(): string {
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function preview(value: unknown, n = 90): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  return s.length > n ? `${s.slice(0, n)}…` : s
}
