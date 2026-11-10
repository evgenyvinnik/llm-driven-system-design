export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 8) : ''
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—'
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${Math.floor(seconds)}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

export function clock(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'
}

export function duration(start: string | null | undefined, end: string | null | undefined): string {
  if (!start) return '—'
  const ms = Math.max(0, (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime())
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

export function millis(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

const TRIGGER_LABEL: Record<string, string> = {
  initial: 'first attempt',
  rerun_job: 're-run of this job',
  rerun_failed: 're-run failed',
  rerun_all: 're-run all',
  rerun_dependent: 'a prerequisite was re-run',
  lease_expired: 'automatic: the previous runner was lost',
  attention_retry: 'retry after a human decision',
}

export const triggerLabel = (trigger: string) => TRIGGER_LABEL[trigger] ?? trigger
