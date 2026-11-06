import { createFileRoute } from '@tanstack/react-router'
import { DeadLetters } from '@/components/ops/DeadLetters'
import { FaultPanel } from '@/components/ops/FaultPanel'
import { GroupTable } from '@/components/ops/GroupTable'
import { OpsTiles } from '@/components/ops/OpsTiles'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { PageHeader } from '@/components/shared/PageHeader'
import { useFetch, usePolling } from '@/lib/hooks'
import { api } from '@/services/api'

export const Route = createFileRoute('/ops')({ component: OpsPage })

export function OpsPage() {
  const tick = usePolling(2000)
  const overview = useFetch(() => api.opsStreams(), [tick])
  const dlq = useFetch(() => api.deadLetters(), [tick])
  const refresh = () => {
    overview.reload()
    dlq.reload()
  }
  const o = overview.data
  return (
    <div className="page space-y-4">
      <PageHeader
        title="Ops / Streams"
        subtitle="The event pipeline: the event store (outbox) → relay → one broker stream per event family → consumer groups. Each group applies a message once (processed-events), acks after commit, and dead-letters what it can't process."
      />
      {overview.error && <ErrorNote message={overview.error} />}
      {o ? <OpsTiles o={o} /> : <Loading />}
      <section className="card overflow-hidden">
        <h2 className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-900">Dead-letter stream {o ? `(${o.dlq.depth})` : ''}</h2>
        {dlq.data ? (
          <DeadLetters entries={dlq.data.entries} onRedrive={async (id) => { await api.redrive(id); refresh() }} onRedriveAll={async () => { await api.redriveAll(); refresh() }} />
        ) : <Loading />}
      </section>
      <section className="card overflow-hidden">
        <h2 className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-900">Consumer groups</h2>
        {o ? <GroupTable groups={o.groups} /> : <Loading />}
      </section>
      <div className="grid grid-cols-[1fr_1fr_1.4fr] gap-4">
        <section className="card p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-900">Broker streams</h2>
          <ul className="space-y-1 text-xs">
            {o?.streams.map((s) => (
              <li key={s.key} className="flex justify-between gap-2 font-mono"><span>{s.family}</span><span className="text-slate-500">{s.length.toLocaleString()} msgs · last #{s.lastEventPosition.toLocaleString()}</span></li>
            ))}
          </ul>
        </section>
        <section className="card p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-900">Event mix (all time)</h2>
          <ul className="max-h-48 space-y-0.5 overflow-y-auto text-xs">
            {o?.byType.map((t) => (
              <li key={t.type} className="flex justify-between"><span className="font-mono">{t.type}</span><span className="text-slate-500">{t.n.toLocaleString()}</span></li>
            ))}
          </ul>
        </section>
        <section className="card p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-900">Fault injection <span className="font-normal text-slate-500">· local demo only</span></h2>
          {o && <FaultPanel faults={o.faults} onSet={async (g, f) => { await api.setFault(g, f); refresh() }} onClear={async (g) => { await api.clearFault(g); refresh() }} />}
        </section>
      </div>
    </div>
  )
}
