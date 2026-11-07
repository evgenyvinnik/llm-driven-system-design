import { createFileRoute } from '@tanstack/react-router'
import { DlqTable } from '@/components/streams/DlqTable'
import { GroupTable } from '@/components/streams/GroupTable'
import { EventTypeTable, RateSparkline, ReplayTable, TopicTable } from '@/components/streams/StreamPanels'
import { ErrorNote, Loading, PageHeader, StatTile } from '@/components/shared/Loading'
import { usePoll } from '@/lib/hooks'
import { api } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/streams')({ component: Streams })

export function Streams() {
  const isAdmin = useAuthStore((s) => s.user!.role === 'admin')
  const overview = usePoll(() => api.streams(), [], 3000)
  const dlq = usePoll(() => api.dlq(), [], 3000)
  const unknown = usePoll(() => api.unknownCars(), [], 5000)
  const cal = usePoll(() => api.calibration(), [], 15000)
  const o = overview.data
  const refresh = () => {
    void dlq.refresh()
    void overview.refresh()
    void unknown.refresh()
  }
  if (overview.error) return <div className="page"><ErrorNote message={overview.error} /></div>
  if (!o) return <Loading />
  const dlqTotal = o.groups.reduce((n, g) => n + g.dlqDepth, 0)
  const maxStale = Math.max(...o.groups.map((g) => g.stalenessSeconds))
  const c = cal.data
  return (
    <div className="page space-y-4">
      <PageHeader
        title="Streams & dead letters"
        subtitle="The event store is the outbox: the relay publishes committed events to Valkey stream partitions (car topic keyed by car id, train topic by train run). Each consumer group acks after its database transaction commits; poison messages are retried, then dead-lettered."
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <div className="card px-4 py-3">
          <div className="panel-title">Events / second (60 s)</div>
          <div className="mt-1 text-2xl font-semibold text-slate-900">{o.rates.eventsPerSecond}</div>
          <RateSparkline series={o.rates.series} />
        </div>
        <StatTile label="Outbox backlog" value={o.outbox.backlog} hint={`log position ${o.outbox.last_position ?? 0}, published through ${o.outbox.published_through ?? 0}`} tone={o.outbox.backlog > 100 ? 'warn' : 'default'} />
        <StatTile label="Max projection staleness" value={maxStale === 0 ? '0 s' : `${maxStale} s`} tone={maxStale > 30 ? 'bad' : maxStale > 0 ? 'warn' : 'good'} hint="oldest unfinished message, any group" />
        <StatTile label="Dead letters" value={dlqTotal} tone={dlqTotal ? 'bad' : 'good'} hint="after 4 deliveries" />
        <StatTile label="ETA calibration" value={c && c.n ? `${Math.round((c.inside / c.n) * 100)}%` : '—'} hint={c && c.n ? `of ${c.n} delivered cars inside the 80% band 24 h out; median error ${c.median_error_h?.toFixed(1)} h` : 'needs delivered cars'} />
      </div>
      <div className="card overflow-x-auto">
        <GroupTable groups={o.groups} />
      </div>
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <span className="panel-title">Dead-letter queue</span>
          {unknown.data && unknown.data.cars.length > 0 && (
            <span className="text-xs text-slate-600">
              Unknown to the car registry: {unknown.data.cars.map((u) => u.car_id).join(', ')}
              {isAdmin && (
                <button type="button" className="btn-secondary ml-2 !px-2 !py-0.5 text-xs" onClick={async () => { for (const u of unknown.data!.cars) await api.registerCar(u.car_id); refresh() }}>
                  Register (waybill arrived)
                </button>
              )}
            </span>
          )}
        </div>
        <DlqTable entries={dlq.data?.entries ?? []} canRedrive={isAdmin} onChanged={refresh} />
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="card overflow-hidden"><TopicTable topics={o.topics} /></div>
        <div className="card p-4">
          <div className="panel-title mb-2">Events in the log, by type and schema version</div>
          <EventTypeTable types={o.eventTypes} />
        </div>
        <div className="card overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-2"><span className="panel-title">Projection replays (rebuild from position 0, compare)</span></div>
          <ReplayTable replays={o.replays} />
        </div>
      </div>
    </div>
  )
}
