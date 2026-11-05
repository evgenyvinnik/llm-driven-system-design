export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never'
  const diff = Date.parse(iso) - now
  const abs = Math.abs(diff)
  const units: [number, string][] = [
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
    [1000, 's'],
  ]
  for (const [ms, label] of units) {
    if (abs >= ms) {
      const n = Math.floor(abs / ms)
      return diff < 0 ? `${n}${label} ago` : `in ${n}${label}`
    }
  }
  return 'just now'
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

export const pct = (n: number) => `${n.toFixed(1)}%`
export const num = (n: number) => n.toLocaleString('en-US')

/** Renders a control's observed value compactly: booleans, strings, small objects. */
export function valueText(v: unknown): string {
  if (v === null || v === undefined) return 'not read yet'
  if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return String(v)
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if ('enabled' in o && 'days' in o) return o.enabled ? `enabled, ${o.days} days` : 'disabled'
    if ('enabled' in o && 'workspaceId' in o) return o.enabled ? `on → ${String(o.workspaceId ?? '').split('/').pop()}` : 'off'
    if ('enabled' in o) return o.enabled ? 'enabled' : 'disabled'
    if ('publicNetworkAccess' in o) return `public ${o.publicNetworkAccess}, default ${o.defaultAction}`
    return JSON.stringify(v)
  }
  return String(v)
}

export const EVIDENCE_LABEL: Record<string, string> = {
  safe_to_fix: 'Safe to fix',
  needs_owner_migration: 'Needs owner migration',
  insufficient_evidence: 'Insufficient evidence',
}

/** Categorical slots 1-3 (validated all-pairs for color-vision deficiency) in fixed order. */
export const EVIDENCE_COLOR: Record<string, string> = {
  safe_to_fix: 'bg-series-1',
  needs_owner_migration: 'bg-series-2',
  insufficient_evidence: 'bg-series-3',
}

export function newIdempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}
