import { createFileRoute } from '@tanstack/react-router'
import { ChaosPanel } from '@/components/ops/ChaosPanel'
import { JobsMatrix } from '@/components/ops/JobsMatrix'
import { PoisonedJobs } from '@/components/ops/PoisonedJobs'
import { PurgeBacklog } from '@/components/ops/PurgeBacklog'
import { RunsTable } from '@/components/ops/RunsTable'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { StatTile } from '@/components/shared/StatTile'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'

export const Route = createFileRoute('/ops')({ component: Ops })

function Ops() {
  const ops = usePoll(() => api.ops(), 2000)
  if (!ops.data) return ops.error ? <div className="page"><ErrorNote message={ops.error} /></div> : <Loading />
  const d = ops.data
  const backlog = d.purgeBacklog.filter((p) => p.purgeCompletedAt === null).length
  return (
    <div className="page !max-w-7xl">
      <div>
        <h1 className="h1">Operations</h1>
        <p className="text-sm text-slate-500">Pipeline health across organizations. Operators see ids and counts, never document titles, text or questions.</p>
      </div>
      {ops.error && <ErrorNote message={ops.error} />}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <StatTile label="Queue ready" value={d.queue?.ready ?? '—'} hint={d.queue ? undefined : 'management API unreachable'} />
        <StatTile label="Unacked" value={d.queue?.unacked ?? '—'} />
        <StatTile label="Consumers" value={d.queue?.consumers ?? '—'} />
        <StatTile label="Dead-lettered" value={d.queue?.poison ?? '—'} />
        <StatTile label="Stale index rows" value={d.staleIndex.rows} hint={`${d.staleIndex.documents} documents awaiting metadata sync`} />
        <StatTile label="Purge backlog" value={backlog} hint="deleted, not yet fully purged" />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <JobsMatrix jobs={d.jobs} runningByWorker={d.runningByWorker} />
        <PurgeBacklog items={d.purgeBacklog} />
      </div>
      <PoisonedJobs jobs={d.poisoned} onChange={ops.reload} />
      <ChaosPanel data={d} onChange={ops.reload} />
      <RunsTable runs={d.runs} />
    </div>
  )
}
