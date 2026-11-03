import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { api, type ExportJob } from '../lib/api'
import { localTime } from '../lib/format'

export const Route = createFileRoute('/exports')({ component: Exports })

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone

function Exports() {
  const { data, isPending } = useQuery({
    queryKey: ['exports'],
    queryFn: ({ signal }) => api<{ jobs: ExportJob[] }>('/exports', { signal }),
    refetchInterval: (q) => (q.state.data?.jobs.some((j) => j.status === 'queued' || j.status === 'running') ? 1500 : 10_000),
  })
  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-lg font-semibold">Exports</h1>
        <p className="text-sm text-ink-2">Exports run in the background, one day of data at a time. Files are kept for 24 hours.</p>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm" data-testid="exports">
          <thead className="text-xs text-ink-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Created</th>
              <th className="px-4 py-2 font-medium">Kind</th>
              <th className="px-4 py-2 font-medium">Query</th>
              <th className="px-4 py-2 font-medium">Columns</th>
              <th className="px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {isPending && (
              <tr>
                <td colSpan={5} className="px-4 py-3 text-ink-2">
                  Loading…
                </td>
              </tr>
            )}
            {data?.jobs.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-3 text-ink-2">
                  No exports yet. Start one from the dashboard’s Export menu.
                </td>
              </tr>
            )}
            {data?.jobs.map((j) => (
              <tr key={j.id} className="border-t align-top" style={{ borderColor: 'var(--gridline)' }}>
                <td className="tabular px-4 py-2">{localTime(j.createdAt, tz, 'MMM d HH:mm:ss')}</td>
                <td className="px-4 py-2">{j.kind === 'conversations' ? 'Conversation list' : 'Daily metrics'}</td>
                <td className="px-4 py-2 font-mono text-[11px] text-ink-2">
                  {j.query.org} · {j.query.from.slice(0, 10)} → {j.query.to.slice(0, 10)}
                  {j.query.models && ` · ${j.query.models}`}
                  {j.query.features && ` · ${j.query.features}`}
                </td>
                <td className="px-4 py-2 text-xs text-ink-2">{j.columns.length} columns{j.columns.includes('cost_usd') ? ' incl. cost' : ''}</td>
                <td className="px-4 py-2 text-xs">
                  {j.status === 'succeeded' ? (
                    <a className="font-medium text-series-1 hover:underline" href={`/api/v1/exports/${j.id}/download`}>
                      Download ({Math.max(1, Math.round((j.fileBytes ?? 0) / 1024))} KB)
                    </a>
                  ) : j.status === 'running' ? (
                    `Running: ${j.rowsDone}/${j.rowsTotal ?? '?'} days`
                  ) : j.status === 'failed' ? (
                    <span className="text-status-critical">Failed: {j.error}</span>
                  ) : (
                    j.status
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
