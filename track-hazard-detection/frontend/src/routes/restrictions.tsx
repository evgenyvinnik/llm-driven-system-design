import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { Empty, ErrorNote, Loading } from '@/components/shared/Loading'
import { PageHeader } from '@/components/shared/PageHeader'
import { dateTimeText } from '@/lib/format'
import { useFetch } from '@/lib/hooks'
import { api } from '@/services/api'
import { useLiveStore } from '@/stores/live-store'

export const Route = createFileRoute('/restrictions')({ component: RestrictionsPage })

export function RestrictionsPage() {
  const rev = useLiveStore((s) => s.revisions)
  const [status, setStatus] = useState<'active' | 'all'>('active')
  const { data, error } = useFetch(() => api.restrictions(status), [status, rev.restrictions])
  return (
    <div className="page">
      <PageHeader
        title="Speed restrictions"
        subtitle="Slow orders issued by dispatchers, or automatically by the standing heat order. Lifted automatically when their hazard closes (compensation)."
        actions={
          <select className="input w-36" value={status} onChange={(e) => setStatus(e.target.value as 'active' | 'all')} aria-label="Status">
            <option value="active">Active</option>
            <option value="all">All</option>
          </select>
        }
      />
      {error && <ErrorNote message={error} />}
      {!data ? (
        <Loading />
      ) : (
        <div className="card overflow-x-auto">
          <table className="min-w-full" aria-label="Speed restrictions">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">Restriction</th>
                <th className="th">Limits</th>
                <th className="th whitespace-nowrap">Max speed</th>
                <th className="th">Hazard</th>
                <th className="th">Reason</th>
                <th className="th">Issued</th>
                <th className="th">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.restrictions.map((r) => (
                <tr key={r.restrictionId} className={r.active ? '' : 'text-slate-400'}>
                  <td className="td font-mono text-xs">{r.restrictionId}</td>
                  <td className="td whitespace-nowrap">
                    {r.subdivisionId} MP {r.mpFrom}–{r.mpTo}
                  </td>
                  <td className="td whitespace-nowrap">
                    <span className={`chip font-bold ${r.active ? 'bg-yellow-300 text-yellow-950' : 'bg-slate-100'}`}>{r.maxSpeedMph} mph</span>
                  </td>
                  <td className="td whitespace-nowrap">
                    <Link to="/hazards/$hazardId" params={{ hazardId: r.hazardId }} className="text-accent-700 hover:underline">
                      {r.hazardCode ?? r.hazardId.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="td max-w-xs truncate" title={r.reason}>{r.reason}</td>
                  <td className="td text-xs">
                    {dateTimeText(r.issuedAt)} · {r.automatic ? 'automatic' : r.issuedBy}
                  </td>
                  <td className="td text-xs">{r.active ? <span className="font-semibold text-amber-700">in effect</span> : `lifted ${dateTimeText(r.liftedAt)} by ${r.liftedBy}${r.liftReason ? ` (${r.liftReason})` : ''}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.restrictions.length === 0 && <Empty>No speed restrictions in effect.</Empty>}
        </div>
      )}
    </div>
  )
}
