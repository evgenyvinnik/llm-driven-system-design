import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ModuleGate } from '@/components/access'
import { ErrorNote, Loading, PageHeader } from '@/components/shared'
import { useOrg } from '@/hooks/useOrg'
import { money, number } from '@/lib/format'
import { keys } from '@/lib/keys'
import { api } from '@/services/api'

export const Route = createFileRoute('/orgs/$orgId/analytics')({
  component: () => (
    <ModuleGate module="analytics">
      <AnalyticsPage />
    </ModuleGate>
  ),
})

function AnalyticsPage() {
  const { orgId } = useOrg()
  const [days, setDays] = useState(14)
  const { data, error, isPending } = useQuery({
    queryKey: keys.analytics(orgId, days),
    queryFn: ({ signal }) => api.analytics(orgId, days, signal),
  })
  const series = data?.series ?? []
  const max = Math.max(1, ...series.map((p) => p.total))
  const total = series.reduce((n, p) => n + p.total, 0)
  const resolved = series.reduce((n, p) => n + p.resolved, 0)
  const rated = series.filter((p) => p.csat !== null)
  const csat = rated.length ? rated.reduce((n, p) => n + (p.csat ?? 0), 0) / rated.length : null
  const cost = series.reduce((n, p) => n + (p.costCents ?? 0), 0)

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Analytics"
        description="Volume and outcomes across the projects you can access."
        actions={
          <select className="input w-36" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Range">
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
          </select>
        }
      />
      {isPending && <Loading />}
      {error && <ErrorNote error={error} />}
      {data && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="card p-4"><p className="label">Conversations</p><p className="text-2xl font-semibold">{number(total)}</p></div>
            <div className="card p-4"><p className="label">Resolved by agent</p><p className="text-2xl font-semibold">{total ? Math.round((resolved / total) * 100) : 0}%</p></div>
            <div className="card p-4"><p className="label">Avg CSAT</p><p className="text-2xl font-semibold">{csat ? csat.toFixed(2) : '—'}</p></div>
            {/* The server omits cost for roles without analytics.cost; the tile isn't merely hidden. */}
            {data.costVisible ? (
              <div className="card p-4"><p className="label">Model cost</p><p className="text-2xl font-semibold">{money(cost)}</p></div>
            ) : (
              <div className="card p-4 text-xs text-slate-500"><p className="label">Model cost</p>Visible to admins on the Pro plan.</div>
            )}
          </div>
          <div className="card p-4">
            <p className="mb-3 text-sm font-medium">Conversations per day</p>
            <div className="flex h-48 items-end gap-1" role="img" aria-label={`Daily conversations over ${days} days`}>
              {series.map((p) => (
                <div key={p.day} className="flex flex-1 flex-col justify-end" title={`${new Date(p.day).toLocaleDateString()}: ${p.total} (${p.escalated} escalated)`}>
                  <div className="rounded-t bg-amber-300" style={{ height: `${(p.escalated / max) * 100}%` }} />
                  <div className="bg-brand-500" style={{ height: `${((p.total - p.escalated) / max) * 100}%` }} />
                </div>
              ))}
            </div>
            <p className="mt-2 flex gap-4 text-xs text-slate-500">
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-brand-500" /> handled</span>
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-amber-300" /> escalated</span>
            </p>
          </div>
        </>
      )}
    </div>
  )
}
