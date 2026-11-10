export function ms(v: number | null | undefined): string {
  if (v === null || v === undefined) return '–'
  if (v >= 10_000) return `${(v / 1000).toFixed(1)} s`
  if (v >= 1000) return `${(v / 1000).toFixed(2)} s`
  return `${Math.round(v)} ms`
}

export function int(v: number | null | undefined): string {
  if (v === null || v === undefined) return '–'
  return v.toLocaleString('en-US')
}

export function pct(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined) return '–'
  return `${(v * 100).toFixed(digits)}%`
}

export function timeAgo(iso: string | null): string {
  if (!iso) return '–'
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

export function clock(iso: string | null): string {
  if (!iso) return '–'
  return new Date(iso).toLocaleTimeString('en-US', { hour12: false })
}
