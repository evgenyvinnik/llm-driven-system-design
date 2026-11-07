import { createFileRoute } from '@tanstack/react-router'
import { MockCard } from '@/components/system/MockCard'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'

export const Route = createFileRoute('/system')({ component: SystemPage })

function SystemPage() {
  const { data, error, reload } = usePoll(() => api.system(), 2000)
  return (
    <div className="page">
      <div>
        <h1 className="h1">Mock model and judge</h1>
        <p className="text-sm text-slate-500">Separate processes with call counters, so you can see that re-scoring makes zero model calls and that cancel stops calls within a second.</p>
      </div>
      {error && <ErrorNote message={error} />}
      {!data ? (
        <Loading />
      ) : (
        <>
          <div className="grid grid-cols-4 gap-3" aria-label="Queue">
            {[
              ['Active runs', data.queue.activeRuns],
              ['Pending tasks', data.queue.pendingTasks],
              ['Live leases', data.queue.liveLeases],
              ['Pending scores', data.queue.pendingScores],
            ].map(([label, value]) => (
              <div key={label} className="card px-3 py-2">
                <div className="panel-title">{label}</div>
                <div className="num text-lg font-semibold">{value}</div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <MockCard title="Mock model" target="model" state={data.model} onChanged={reload} />
            <MockCard title="Mock judge" target="judge" state={data.judge} onChanged={reload} />
          </div>
        </>
      )}
    </div>
  )
}
