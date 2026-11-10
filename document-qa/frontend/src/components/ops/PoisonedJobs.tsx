import { useState } from 'react'
import { ReplayIcon } from '@/components/icons'
import { Empty } from '@/components/shared/Loading'
import { ago, shortId } from '@/lib/format'
import { ApiError, api } from '@/services/api'
import type { OpsOverview } from '@/types'

export function PoisonedJobs({ jobs, onChange }: { jobs: OpsOverview['poisoned']; onChange: () => void }) {
  const [error, setError] = useState<string | null>(null)
  async function retry(id: string) {
    setError(null)
    try {
      await api.retryJob(id)
      onChange()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Retry failed')
    }
  }
  return (
    <section className="card" aria-label="Failed jobs">
      <div className="border-b border-slate-100 px-4 py-2">
        <h2 className="panel-title">Failed (poisoned) jobs</h2>
        {error && <p className="text-xs text-rose-800">{error}</p>}
      </div>
      {jobs.length === 0 ? (
        <Empty>No failed jobs.</Empty>
      ) : (
        <table className="w-full" aria-label="Poisoned jobs">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              <th className="th">Job</th>
              <th className="th">Stage</th>
              <th className="th">Attempts</th>
              <th className="th">Last error</th>
              <th className="th" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {jobs.map((j) => (
              <tr key={j.id}>
                <td className="td text-xs">
                  <div className="font-mono">{shortId(j.id)}</div>
                  <div className="text-slate-500">
                    {j.orgName} · doc {shortId(j.documentId)} · {ago(j.finishedAt)}
                  </div>
                </td>
                <td className="td">{j.stage}</td>
                <td className="td num">
                  {j.attempts}/{j.maxAttempts}
                </td>
                <td className="td max-w-sm text-xs text-rose-800">{j.lastError}</td>
                <td className="td">
                  <button type="button" className="btn-secondary !py-1 text-xs" onClick={() => void retry(j.id)}>
                    <ReplayIcon className="h-3 w-3" /> Retry
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
