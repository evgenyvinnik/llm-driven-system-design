/** Display helpers. Text, never colour alone, carries the meaning. */

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return '—'
  const s = Math.round((now - new Date(iso).getTime()) / 1000)
  if (s < 0) return `in ${until(iso, now)}`
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function until(iso: string | null, now = Date.now()): string {
  if (!iso) return '—'
  const s = Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

export function time(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function ms(v: number | null): string {
  if (v === null) return '—'
  return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`
}

export function pct(v: number | null): string {
  return v === null ? '—' : `${Math.round(v * 1000) / 10}%`
}

export function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id
}

export const ERROR_CLASS_LABEL: Record<string, string> = {
  ok: 'OK',
  http_5xx: 'Server error (5xx)',
  http_429: 'Rate limited (429)',
  http_410: 'Gone (410)',
  http_4xx: 'Rejected (4xx)',
  http_3xx: 'Redirect (not followed)',
  timeout: 'Timeout',
  connection_error: 'Connection error',
  dns_error: 'DNS error',
  ssrf_blocked: 'Blocked (SSRF)',
  invalid_url: 'Invalid URL',
  worker_lost: 'Worker lost',
  endpoint_disabled: 'Endpoint disabled',
}

export const DISABLED_REASON_LABEL: Record<string, string> = {
  retry_horizon_exhausted: 'retry window exhausted',
  gone_410: 'receiver answered 410 Gone',
  ssrf_blocked: 'URL resolved to a blocked address',
  invalid_url: 'invalid URL',
  manual: 'disabled by your team',
}
