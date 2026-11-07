import { EVENT_LABEL, ago } from '@/lib/format'
import type { DocEvent } from '@/types'

function describe(e: DocEvent): string {
  const d = e.detail as Record<string, unknown>
  if (e.kind === 'sharing_changed') {
    const to = d.to as { scope?: string } | undefined
    const from = d.from as { scope?: string } | undefined
    return `${from?.scope ?? '?'} → ${to?.scope ?? '?'}`
  }
  if (e.kind === 'version_activated') return `now serving v${String(d.versionNo)}${d.previousVersionNo ? ` (was v${String(d.previousVersionNo)})` : ''}`
  if (e.kind === 'version_uploaded' || e.kind === 'uploaded') return `v${String(d.versionNo)} · ${String(d.filename ?? '')}`
  if (e.kind === 'processing_failed') return String(d.reason ?? '')
  return ''
}

export function EventsList({ events }: { events: DocEvent[] }) {
  return (
    <section className="card p-4" aria-label="Activity">
      <h2 className="panel-title mb-2">Activity</h2>
      <ul className="space-y-1.5 text-sm">
        {events.map((e) => (
          <li key={e.id} className="flex gap-2">
            <span className="w-16 shrink-0 text-xs text-slate-400">{ago(e.createdAt)}</span>
            <span className="font-medium text-slate-700">{EVENT_LABEL[e.kind] ?? e.kind}</span>
            <span className="min-w-0 truncate text-slate-500" title={describe(e)}>
              {describe(e)}
              {e.actor ? ` · ${e.actor}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
