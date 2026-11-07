/** Status, cache and retrieval trace, and usage for one answer run. */
import { StatusChip } from '@/components/shared/Chips'
import { DROP_REASON_LABEL, ms } from '@/lib/format'
import type { Run } from '@/types'

export function CacheBadge({ run }: { run: Run }) {
  const c = run.cache
  if (c.status === 'hit')
    return <span className="chip bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200">Served from cache (validated {c.validatedDocuments ?? 0} sources)</span>
  if (c.status === 'rejected') return <span className="chip bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200">Cache entry rejected: {c.reason}</span>
  return null
}

export function RetrievalLine({ run }: { run: Run }) {
  const r = run.retrieval
  if (r.fromCache || r.candidates === undefined) return null
  const dropped = (r.dropped ?? []).reduce((n, d) => n + d.count, 0)
  return (
    <p className="text-xs text-slate-500" aria-label="Retrieval trace">
      {r.candidates} candidates · {r.kept ?? 0} kept
      {dropped > 0 && (
        <span className="text-amber-800">
          {' '}
          · {dropped} dropped by access re-check:{' '}
          {(r.dropped ?? []).map((d) => `${DROP_REASON_LABEL[d.reason] ?? d.reason} ×${d.count}${d.staleIndex > 0 ? ` (index said readable: ${d.staleIndex})` : ''}`).join(', ')}
        </span>
      )}
      {r.ms !== undefined && ` · ${r.ms} ms`}
    </p>
  )
}

export function StatusLine({ run }: { run: Run }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusChip status={run.status} />
      <CacheBadge run={run} />
      {run.status === 'failed' && <span className="text-xs text-rose-800">{run.error}{run.outputText ? ' · partial output kept' : ''}</span>}
      {run.status === 'cancelled' && <span className="text-xs text-slate-500">Stopped{run.outputText ? ' · partial output kept' : ''}</span>}
    </div>
  )
}

export function UsageLine({ run }: { run: Run }) {
  const u = run.usage
  if (run.status === 'queued' || run.status === 'running') return null
  return (
    <p className="num text-[11px] text-slate-400" aria-label="Usage">
      {u.inputTokens ?? '—'} in / {u.outputTokens ?? '—'} out tokens · queue {ms(u.queueMs)} · retrieval {ms(u.retrievalMs)} · first token {ms(u.ttftMs)} · generation{' '}
      {ms(u.generationMs)}
      {run.model ? ` · ${run.model}` : ''}
    </p>
  )
}
