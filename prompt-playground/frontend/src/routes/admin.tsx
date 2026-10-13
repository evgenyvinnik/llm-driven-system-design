import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { ExecutorsPanel, FailuresList, HourlyRunsChart, ModelControls, ModelTable, StatTile } from '@/components/admin'
import { RequireAuth } from '@/components/layout'
import { ErrorNote, Loading } from '@/components/shared'
import { api } from '@/services/api'
import type { AdminOverview } from '@/types'

export const Route = createFileRoute('/admin')({
  component: () => (
    <RequireAuth admin>
      <AdminPage />
    </RequireAuth>
  ),
})

const REFRESH_MS = 5000

function AdminPage() {
  const [data, setData] = useState<AdminOverview | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () =>
      api
        .adminOverview()
        .then((d) => !cancelled && (setData(d), setError(null)))
        .catch((err: Error) => !cancelled && setError(err.message))
    void load()
    const timer = setInterval(load, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  if (!data) return error ? <div className="p-8"><ErrorNote message={error} /></div> : <Loading />

  const counts = data.statusCounts
  const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0)
  const failed = counts.failed ?? 0
  return (
    <main className="mx-auto max-w-7xl space-y-4 px-6 py-8">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Operations</h1>
        <p className="text-sm text-slate-500">Run health across the platform. Refreshes every {REFRESH_MS / 1000} seconds.</p>
      </div>
      {error && <ErrorNote message={`Showing the last good data: ${error}`} />}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Runs in the last 24h" value={total.toLocaleString()} detail={`${counts.completed ?? 0} completed · ${counts.cancelled ?? 0} cancelled`} />
        <StatTile label="Failure rate" value={total ? `${((failed / total) * 100).toFixed(1)}%` : '—'} detail={`${failed} failed runs`} />
        <StatTile label="In progress" value={`${data.active.running + data.active.queued}`} detail={`${data.active.running} running · ${data.active.queued} queued`} />
        <StatTile
          label="Oldest queued run"
          value={data.active.oldestQueuedSeconds === null ? 'none' : `${Math.round(data.active.oldestQueuedSeconds)}s`}
          detail="Grows when executors are saturated or down"
        />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <HourlyRunsChart hourly={data.hourly} />
          <ModelTable rows={data.perModel} />
        </div>
        <div className="space-y-4">
          <ModelControls />
          <ExecutorsPanel executors={data.executors} topUsers={data.topUsers} />
          <FailuresList failures={data.recentFailures} />
        </div>
      </div>
    </main>
  )
}
