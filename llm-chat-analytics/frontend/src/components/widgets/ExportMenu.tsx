/**
 * Exports run as background jobs: the click creates a job (once, even if the
 * request is retried), and a progress card polls it until the file is ready.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, ApiError, type ExportJob } from '../../lib/api'
import type { ResolvedQuery } from '../../lib/filters'
import { useExports } from '../../stores/exports'
import { CheckIcon, ChevronDownIcon, CloseIcon, DownloadIcon, SpinnerIcon } from '../icons'

export function ExportMenu({ query, canExportConversations }: { query: ResolvedQuery | null; canExportConversations: boolean }) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const start = useExports((s) => s.start)
  const run = async (kind: ExportJob['kind']) => {
    if (!query) return
    setOpen(false)
    setError(null)
    try {
      await start(kind, query)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the export. Try again; it will not create a duplicate.')
    }
  }
  return (
    <div className="relative">
      <button type="button" className="btn-secondary" onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={!query}>
        <DownloadIcon className="h-3.5 w-3.5" /> Export <ChevronDownIcon className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="card absolute right-0 z-20 mt-1 w-64 p-1 shadow-lg" role="menu">
          <button type="button" role="menuitem" className="w-full rounded px-3 py-2 text-left text-sm hover:bg-plane" onClick={() => run('daily_metrics')}>
            Daily metrics (CSV)
            <span className="block text-xs text-ink-2">One row per day, model and feature</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!canExportConversations}
            className="w-full rounded px-3 py-2 text-left text-sm hover:bg-plane disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => run('conversations')}
          >
            Conversation list (CSV)
            <span className="block text-xs text-ink-2">{canExportConversations ? 'Metadata for every conversation in range' : 'Not available for your role'}</span>
          </button>
        </div>
      )}
      {error && <p className="absolute right-0 mt-1 w-64 text-xs text-status-critical">{error}</p>}
    </div>
  )
}

/** Progress cards for jobs started in this tab, bottom-right. */
export function ExportProgress() {
  const watching = useExports((s) => s.watching)
  if (watching.length === 0) return null
  return (
    <div className="fixed bottom-4 right-4 z-30 w-80 space-y-2" aria-live="polite">
      {watching.map((id) => (
        <JobCard key={id} id={id} />
      ))}
    </div>
  )
}

function JobCard({ id }: { id: string }) {
  const dismiss = useExports((s) => s.dismiss)
  const { data } = useQuery({
    queryKey: ['export', id],
    queryFn: ({ signal }) => api<ExportJob>(`/exports/${id}`, { signal }),
    refetchInterval: (q) => (q.state.data && ['succeeded', 'failed', 'expired'].includes(q.state.data.status) ? false : 1000),
  })
  const pct = data?.rowsTotal ? Math.round((data.rowsDone / data.rowsTotal) * 100) : 0
  return (
    <div className="card p-3 shadow-lg" data-testid="export-progress">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium">{data?.kind === 'conversations' ? 'Conversation list' : 'Daily metrics'} export</p>
        <button type="button" className="text-ink-muted hover:text-ink" onClick={() => dismiss(id)} aria-label="Dismiss">
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      {!data || data.status === 'queued' ? (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-2">
          <SpinnerIcon className="h-3 w-3" /> Queued
        </p>
      ) : data.status === 'running' ? (
        <>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-plane" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-1.5 rounded bg-series-1 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1 text-xs text-ink-2">
            {data.rowsDone} of {data.rowsTotal ?? '?'} days written · you can keep working
          </p>
        </>
      ) : data.status === 'succeeded' ? (
        <a className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-series-1 hover:underline" href={`/api/v1/exports/${id}/download`}>
          <CheckIcon className="h-3.5 w-3.5" /> Download CSV ({Math.max(1, Math.round((data.fileBytes ?? 0) / 1024))} KB)
        </a>
      ) : (
        <p className="mt-1 text-xs text-status-critical">{data.status === 'expired' ? 'Expired' : `Failed: ${data.error}`}</p>
      )}
    </div>
  )
}
