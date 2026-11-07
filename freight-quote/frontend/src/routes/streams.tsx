import { createFileRoute } from '@tanstack/react-router'
import { DlqTable } from '@/components/streams/DlqTable'
import { Deliveries } from '@/components/streams/Deliveries'
import { GroupTable } from '@/components/streams/GroupTable'
import { ProjectionPanel } from '@/components/streams/ProjectionPanel'
import { PageHeader } from '@/components/shared/PageHeader'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { Stat } from '@/components/shared/Badges'
import { usePolling } from '@/lib/hooks'
import { api } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/streams')({ component: StreamsPage })

export function StreamsPage() {
  const user = useAuthStore((s) => s.user)
  const overview = usePolling(() => api.streams(), 2000)
  const dlq = usePolling(() => api.deadLetters(), 2000)
  const hooks = usePolling(() => api.deliveries(), 2000)
  const refresh = () => {
    overview.reload()
    dlq.reload()
    hooks.reload()
  }
  const o = overview.data
  if (!o) return overview.error ? <div className="page"><ErrorNote message={overview.error} /></div> : <Loading />
  return (
    <div className="page">
      <PageHeader title="Streams & DLQ" subtitle="Outbox relay backlog, consumer lag per group, the dead-letter stream with redrive, the analytics projection and its replay check, and signed webhook deliveries." />
      <div className="mb-4 grid grid-cols-5 gap-3">
        <Stat label="Events / s (1 min)" value={o.eventsPerSecond} />
        <Stat label="Outbox unpublished" value={o.outbox.unpublished} tone={o.outbox.unpublished > 0 ? 'bad' : 'default'} hint={o.outbox.oldestAgeSeconds !== null ? `oldest ${o.outbox.oldestAgeSeconds}s` : undefined} />
        <Stat label="Total consumer lag" value={o.groups.reduce((s, g) => s + g.lag, 0)} />
        <Stat label="DLQ depth" value={o.dlqDepth} tone={o.dlqDepth > 0 ? 'bad' : 'good'} />
        <Stat label="Projection staleness" value={`${o.projection?.stalenessSeconds ?? 0} s`} />
      </div>
      <div className="grid grid-cols-[1fr,320px] gap-5">
        <div className="min-w-0 space-y-4">
          <GroupTable groups={o.groups} lengths={o.streamLengths} />
          <DlqTable letters={dlq.data?.deadLetters ?? []} onChange={refresh} />
          <Deliveries deliveries={hooks.data?.deliveries ?? []} receipts={hooks.data?.receiver?.receipts ?? []} failNext={hooks.data?.receiver?.knobs.failNext ?? 0} onChange={refresh} />
        </div>
        <div className="space-y-4">
          <ProjectionPanel projection={o.projection} canRebuild={user?.role === 'admin'} />
          <section className="card p-4 text-xs text-slate-600">
            <div className="panel-title mb-2">Events in the last minute</div>
            {Object.keys(o.eventsLastMinute).length === 0 ? (
              <p className="text-slate-500">None.</p>
            ) : (
              <ul className="space-y-1">
                {Object.entries(o.eventsLastMinute).map(([type, n]) => (
                  <li key={type} className="flex justify-between">
                    <span>{type}</span>
                    <span className="tabular-nums">{n}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
