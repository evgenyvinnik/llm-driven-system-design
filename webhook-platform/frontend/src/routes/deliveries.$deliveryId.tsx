import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { ReplayIcon } from '@/components/icons'
import { AttemptTimeline } from '@/components/deliveries/AttemptTimeline'
import { StateChip, TypeChip } from '@/components/shared/Chips'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { ago, time, until } from '@/lib/format'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'

export const Route = createFileRoute('/deliveries/$deliveryId')({ component: DeliveryPage })

function DeliveryPage() {
  const { deliveryId } = Route.useParams()
  const { data, error, reload } = usePoll(() => api.delivery(deliveryId), 1500, [deliveryId])
  const [replayError, setReplayError] = useState<string | null>(null)

  async function replay() {
    setReplayError(null)
    try {
      await api.replayDelivery(deliveryId)
      reload()
    } catch (err) {
      setReplayError(err instanceof Error ? err.message : 'Replay failed')
    }
  }

  if (error) return <div className="page"><ErrorNote message={error} /></div>
  if (!data) return <Loading />
  const { delivery: d, event, attempts } = data
  const canReplay = d.state === 'failed' || d.state === 'delivered'
  return (
    <div className="page">
      <Link to="/endpoints/$endpointId" params={{ endpointId: d.endpointId }} className="text-xs text-slate-500 hover:text-slate-800">
        ← {d.endpointDescription}
      </Link>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="h1 font-mono text-lg">{d.id}</h1>
            <StateChip state={d.state} />
          </div>
          <p className="mt-1 text-sm text-slate-600">
            Event <Link to="/events/$eventId" params={{ eventId: event.id }} className="font-mono text-accent-700 hover:underline">{event.id}</Link> → <span className="font-mono">{d.endpointUrl}</span>
          </p>
        </div>
        <button type="button" className="btn-primary" disabled={!canReplay} onClick={() => void replay()} title={canReplay ? 'New attempt for the same event id' : 'Already pending'}>
          <ReplayIcon /> Replay
        </button>
      </div>
      {replayError && <ErrorNote message={replayError} />}
      <div className="grid gap-3 text-sm md:grid-cols-4">
        <Fact label="Event type"><TypeChip type={event.type} /></Fact>
        <Fact label="Attempts">{d.attemptCount}{d.replayCount > 0 ? ` (replayed ×${d.replayCount})` : ''}</Fact>
        <Fact label={d.state === 'scheduled' ? 'Next attempt' : 'Delivered'}>
          {d.state === 'scheduled' ? `in ${until(d.nextAttemptAt)}` : d.deliveredAt ? time(d.deliveredAt) : '—'}
        </Fact>
        <Fact label="Retry window ends">{d.retryDeadline ? `${time(d.retryDeadline)} (${ago(d.retryDeadline)})` : '—'}</Fact>
      </div>
      <section className="card">
        <h2 className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">Attempts</h2>
        <AttemptTimeline attempts={attempts} />
      </section>
      <section className="card p-4">
        <h2 className="panel-title mb-2">Payload sent (same bytes on every attempt)</h2>
        <pre className="overflow-x-auto rounded-md bg-slate-900 p-3 font-mono text-xs text-slate-100">
          {JSON.stringify({ id: event.id, type: event.type, created_at: event.createdAt, ...(event.orderingKey ? { ordering_key: event.orderingKey, sequence: event.sequence } : {}), data: event.data }, null, 2)}
        </pre>
      </section>
    </div>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="card px-3 py-2">
      <div className="panel-title">{label}</div>
      <div className="mt-0.5 text-slate-800">{children}</div>
    </div>
  )
}
