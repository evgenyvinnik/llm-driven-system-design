import { createFileRoute, Link } from '@tanstack/react-router'
import { Fragment, useState } from 'react'
import { summarize } from '@/components/hazard/summarize'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { PageHeader } from '@/components/shared/PageHeader'
import { timeText } from '@/lib/format'
import { useFetch } from '@/lib/hooks'
import { api } from '@/services/api'
import { useLiveStore } from '@/stores/live-store'

export const Route = createFileRoute('/events')({ component: EventsPage })

/** The domain event store, newest first: every hazard, alert, warning, slow order and coverage change. */
export function EventsPage() {
  const rev = useLiveStore((s) => s.revisions)
  const [type, setType] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const { data, error } = useFetch(() => api.events({ type: type || undefined, limit: 150 }), [type, rev.hazards, rev.alerts, rev.coverage])
  return (
    <div className="page">
      <PageHeader
        title="Event log"
        subtitle="The append-only event store (source of truth). Global position orders the whole log; stream version orders each hazard."
        actions={
          <select className="input w-64" value={type} onChange={(e) => setType(e.target.value)} aria-label="Event type">
            <option value="">All types</option>
            {data?.counts.map((c) => (
              <option key={c.type} value={c.type}>
                {c.type} ({c.n})
              </option>
            ))}
          </select>
        }
      />
      {error && <ErrorNote message={error} />}
      {!data ? (
        <Loading />
      ) : (
        <div className="card overflow-x-auto">
          <table className="min-w-full" aria-label="Event log">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">#</th>
                <th className="th">Recorded</th>
                <th className="th">Type</th>
                <th className="th whitespace-nowrap">Stream · v</th>
                <th className="th whitespace-nowrap">Partition key</th>
                <th className="th">Source</th>
                <th className="th">Summary</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.events.map((e) => (
                <Fragment key={e.eventId}>
                  <tr className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(open === e.eventId ? null : e.eventId)}>
                    <td className="td font-mono text-xs text-slate-400">{e.globalPosition}</td>
                    <td className="td whitespace-nowrap text-xs">{timeText(e.recordedAt)}</td>
                    <td className="td whitespace-nowrap font-medium text-slate-900">{e.type}</td>
                    <td className="td whitespace-nowrap font-mono text-xs">
                      {e.streamId.startsWith('hazard-') ? (
                        <Link to="/hazards/$hazardId" params={{ hazardId: e.streamId.slice(7) }} className="text-accent-700 hover:underline" onClick={(ev) => ev.stopPropagation()}>
                          hazard-{e.streamId.slice(7, 15)}
                        </Link>
                      ) : (
                        e.streamId
                      )}{' '}
                      · v{e.streamVersion}
                    </td>
                    <td className="td font-mono text-xs">{e.partitionKey}</td>
                    <td className="td text-xs">{String(e.meta.actor ?? e.source)}</td>
                    <td className="td max-w-xl truncate text-xs text-slate-600">{summarize(e)}</td>
                  </tr>
                  {open === e.eventId && (
                    <tr>
                      <td colSpan={7} className="bg-slate-50 px-3 py-2">
                        <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-slate-700">{JSON.stringify(e, null, 2)}</pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
