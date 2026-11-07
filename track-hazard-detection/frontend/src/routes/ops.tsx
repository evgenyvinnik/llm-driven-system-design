import { createFileRoute } from '@tanstack/react-router'
import { DlqTable } from '@/components/ops/DlqTable'
import { GatewaysTable } from '@/components/ops/GatewaysTable'
import { GroupsTable } from '@/components/ops/GroupsTable'
import { ProjectionsTable } from '@/components/ops/ProjectionsTable'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { PageHeader, StatTile } from '@/components/shared/PageHeader'
import { secondsText } from '@/lib/format'
import { useFetch, useTicker } from '@/lib/hooks'
import { api } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/ops')({ component: OpsPage })

const LANES = ['critical', 'domain', 'trains', 'bulk']

export function OpsPage() {
  const user = useAuthStore((s) => s.user)
  const tick = useTicker(3000)
  const { data, error, reload } = useFetch(() => Promise.all([api.ops(), api.deadLetters()]), [Math.floor(tick / 3000)])
  if (error && !data) return <div className="page"><ErrorNote message={error} /></div>
  if (!data) return <Loading />
  const [ops, dlq] = data
  const admin = user?.role === 'admin'
  const backlog = (lane: string) => ops.outbox.find((o) => o.lane === lane)
  const totalLag = ops.groups.reduce((n, g) => n + (g.lag ?? 0), 0)
  return (
    <div className="page space-y-4">
      <PageHeader title="Streams & dead letters" subtitle="Outbox → Valkey Streams (Kafka stand-in, 4 partitions per topic, keyed by track segment) → consumer groups. Refreshes every 3 s." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <StatTile label="Edge events / s" value={ops.rates.edgePerSecond} hint={`${ops.rates.edgeTotal.toLocaleString()} total`} />
        <StatTile label="Domain events / s" value={ops.rates.domainPerSecond} hint={`${ops.rates.domainTotal.toLocaleString()} in the store`} />
        <StatTile label="Consumer lag" value={<span className={totalLag > 100 ? 'text-amber-600' : ''}>{totalLag.toLocaleString()}</span>} hint="all groups, all partitions" />
        <StatTile label="Late (last min)" value={ops.rates.lateLastMinute} hint="recorded > 30 s after they occurred" />
        <StatTile label="Dead letters" value={<span className={ops.dlq.dead ? 'text-red-600' : ''}>{ops.dlq.dead}</span>} hint={`${ops.dlq.total} total`} />
        <StatTile label="Outbox backlog" value={LANES.reduce((n, l) => n + (backlog(l)?.unpublished ?? 0), 0)} hint={LANES.map((l) => `${l} ${backlog(l)?.unpublished ?? 0}`).join(' · ')} />
      </div>
      <section className="card overflow-x-auto">
        <h2 className="panel-title border-b border-slate-100 px-4 py-2.5">Consumer groups and lag</h2>
        <GroupsTable groups={ops.groups} />
        <p className="px-4 py-2 text-xs text-slate-500">
          Processed-event rows (idempotency): {ops.processed.map((p) => `${p.consumer} ${p.n.toLocaleString()}`).join(' · ')}. Oldest unpublished outbox row:{' '}
          {secondsText(Math.max(0, ...ops.outbox.map((o) => o.oldestSeconds ?? 0)))}.
        </p>
      </section>
      <section className="card overflow-x-auto">
        <h2 className="panel-title border-b border-slate-100 px-4 py-2.5">Dead-letter queue (th:dlq)</h2>
        <DlqTable rows={dlq.deadLetters} canAct={admin} onDone={reload} />
      </section>
      <div className="grid gap-4 xl:grid-cols-2">
        <section className="card overflow-x-auto">
          <h2 className="panel-title border-b border-slate-100 px-4 py-2.5">Projections (rebuildable from the event store)</h2>
          <ProjectionsTable projections={ops.projections} canReplay={admin} onDone={reload} />
        </section>
        <section className="card overflow-x-auto">
          <h2 className="panel-title border-b border-slate-100 px-4 py-2.5">Gateways and watermarks</h2>
          <GatewaysTable gateways={ops.gateways} />
        </section>
      </div>
    </div>
  )
}
