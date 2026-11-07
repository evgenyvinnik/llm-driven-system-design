/** Display helpers. Text, never colour alone, carries the meaning. */

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return '—'
  const s = Math.round((now - new Date(iso).getTime()) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function time(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function ms(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—'
  return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`
}

export function duration(from: string | null, to: string | null): string {
  if (!from || !to) return '—'
  return ms(new Date(to).getTime() - new Date(from).getTime())
}

export function bytes(n: number | null): string {
  if (n === null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id
}

export function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** "done/total" from a stage progress object, when it has both. */
export function progressText(p: Record<string, unknown>): string | null {
  const done = num(p.done)
  const total = num(p.total)
  return done !== null && total !== null ? `${done}/${total}` : null
}

export const DROP_REASON_LABEL: Record<string, string> = {
  deleted: 'document deleted',
  other_tenant: 'other organization',
  user_inactive: 'account inactive',
  not_owner: 'private to its owner',
  not_in_group: 'not a member of the shared group',
  chunk_missing: 'chunk retired or purged',
  not_current_version: 'not the current version',
}

export const STAGE_ORDER = ['extract', 'chunk', 'embed', 'index', 'retire', 'sync_acl', 'purge']

export const STAGE_LABEL: Record<string, string> = {
  extract: 'Extract',
  chunk: 'Chunk',
  embed: 'Embed',
  index: 'Index',
  retire: 'Retire old version',
  sync_acl: 'Sync index access metadata',
  purge: 'Purge',
}

export const EVENT_LABEL: Record<string, string> = {
  uploaded: 'Uploaded',
  version_uploaded: 'New version uploaded',
  version_activated: 'Version switched',
  sharing_changed: 'Sharing changed',
  processing_failed: 'Processing failed',
  retry_requested: 'Retry requested',
  deleted: 'Deleted (tombstone)',
  purged: 'Purge completed',
}
