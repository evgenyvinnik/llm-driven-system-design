import { Link, createFileRoute } from '@tanstack/react-router'
import { PlusIcon } from '@/components/icons'
import { RunsTable } from '@/components/runs/RunsTable'
import { Empty, ErrorNote, Loading } from '@/components/shared/Loading'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'

export const Route = createFileRoute('/runs/')({ component: RunsPage })

function RunsPage() {
  const { data, error, loading } = usePoll(() => api.runs(), 2000)
  return (
    <div className="page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="h1">Eval runs</h1>
          <p className="text-sm text-slate-500">Each run pins a dataset version, prompt version, model config and scorer versions. Aggregates exclude errored cases and say how many.</p>
        </div>
        <Link to="/runs/new" className="btn-primary">
          <PlusIcon /> New run
        </Link>
      </div>
      {error && <ErrorNote message={error} />}
      {loading && !data ? <Loading /> : data && data.runs.length > 0 ? <RunsTable runs={data.runs} /> : <Empty>No runs yet.</Empty>}
    </div>
  )
}
