import { Link, createFileRoute } from '@tanstack/react-router'
import { DeliveriesTable } from '@/components/deliveries/DeliveriesTable'
import { TypeChip } from '@/components/shared/Chips'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { time } from '@/lib/format'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'

export const Route = createFileRoute('/events/$eventId')({ component: EventPage })

function EventPage() {
  const { eventId } = Route.useParams()
  const { data, error } = usePoll(() => api.event(eventId), 2000, [eventId])
  if (error) return <div className="page"><ErrorNote message={error} /></div>
  if (!data) return <Loading />
  const { event: e, deliveries } = data
  return (
    <div className="page">
      <Link to="/events" className="text-xs text-slate-500 hover:text-slate-800">← Event log</Link>
      <div>
        <div className="flex items-center gap-2">
          <h1 className="h1 font-mono text-lg">{e.id}</h1>
          <TypeChip type={e.type} />
        </div>
        <p className="mt-1 text-sm text-slate-600">
          Created {time(e.createdAt)} via {e.source} · Idempotency-Key <span className="code">{e.idempotencyKey}</span>
          {e.orderingKey && <> · ordering key <span className="code">{e.orderingKey}</span> sequence <strong>{e.sequence}</strong></>}
        </p>
      </div>
      <section className="card">
        <h2 className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">Deliveries (one per matching endpoint)</h2>
        <DeliveriesTable deliveries={deliveries} showEndpoint />
      </section>
      <section className="card p-4">
        <h2 className="panel-title mb-2">Data</h2>
        <pre className="overflow-x-auto rounded-md bg-slate-900 p-3 font-mono text-xs text-slate-100">{JSON.stringify(e.data, null, 2)}</pre>
      </section>
    </div>
  )
}
