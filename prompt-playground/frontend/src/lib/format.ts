export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
}

export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString()
}

/** "v3", "Draft", or "Draft · now v4" when the draft text was later saved. */
export function versionLabel(version: number | null, savedVersion: number | null): string {
  if (version !== null) return `v${version}`
  return savedVersion !== null ? `Draft · now v${savedVersion}` : 'Draft'
}

export function newId(): string {
  return crypto.randomUUID()
}
