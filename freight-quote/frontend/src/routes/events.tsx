import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { EventRow } from '@/components/events/EventRow'
import { PageHeader } from '@/components/shared/PageHeader'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { usePolling } from '@/lib/hooks'
import { api } from '@/services/api'

export const Route = createFileRoute('/events')({ component: EventsPage })

export function EventsPage() {
  const [type, setType] = useState<string | undefined>(undefined)
  const [old, setOld] = useState(false)
  const { data, error } = usePolling(() => api.events({ type, limit: 150, old: old ? '1' : undefined }), 3000, [type, old])
  return (
    <div className="page">
      <PageHeader
        title="Event log"
        subtitle="The append-only log in PostgreSQL: the transactional outbox and the integration backbone. Newest first. Click a row for its envelope and payload; older schema versions show how consumers read them after upcasting."
      />
      <ErrorNote message={error} />
      {!data ? (
        <Loading />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter by type">
            <button type="button" onClick={() => setType(undefined)} className={`chip ${!type ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 ring-1 ring-slate-200'}`}>
              All
            </button>
            <button type="button" onClick={() => setOld(!old)} className={`chip ${old ? 'bg-amber-600 text-white' : 'bg-amber-50 text-amber-800 ring-1 ring-amber-200'}`} title="Events stored before the QuoteIssued v2 migration">
              Older schema versions only
            </button>
            {data.counts.map((c) => (
              <button key={c.type} type="button" onClick={() => setType(c.type)} className={`chip ${type === c.type ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 ring-1 ring-slate-200'}`}>
                {c.type} <span className="tabular-nums opacity-70">{c.n}</span>
              </button>
            ))}
          </div>
          <div className="card overflow-hidden">
            <table className="w-full" aria-label="Events">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">Position</th>
                  <th className="th">Type</th>
                  <th className="th">Stream</th>
                  <th className="th">Occurred (event time)</th>
                  <th className="th">Recorded</th>
                  <th className="th">Producer</th>
                  <th className="th">Correlation</th>
                  <th className="th">Outbox</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.events.map((e) => (
                  <EventRow key={e.event_id} event={e} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
