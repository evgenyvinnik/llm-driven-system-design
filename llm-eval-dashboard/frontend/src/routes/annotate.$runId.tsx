import { Link, createFileRoute } from '@tanstack/react-router'
import { AgreementPanel } from '@/components/annotate/AgreementPanel'
import { QueueItemCard } from '@/components/annotate/QueueItemCard'
import { Empty, ErrorNote, Loading } from '@/components/shared/Loading'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'

export const Route = createFileRoute('/annotate/$runId')({ component: AnnotatePage })

function AnnotatePage() {
  const { runId } = Route.useParams()
  const queue = usePoll(() => api.annotations(runId), 10_000, [runId])
  const run = usePoll(() => api.run(runId), 30_000, [runId])
  return (
    <div className="page max-w-6xl">
      <div>
        <Link to="/runs/$runId" params={{ runId }} className="text-xs text-accent-700 hover:underline">
          ← {run.data?.run.name ?? runId}
        </Link>
        <h1 className="h1">Annotation queue</h1>
        <p className="text-sm text-slate-500">Outputs where the judge was unsure or samples disagreed, plus a random slice for an unbiased agreement estimate. Labels feed the run's human scorer.</p>
      </div>
      {queue.error && <ErrorNote message={queue.error} />}
      {!queue.data ? (
        <Loading />
      ) : (
        <>
          <AgreementPanel queue={queue.data} />
          {queue.data.items.length === 0 ? (
            <Empty>Nothing to review on this run.</Empty>
          ) : (
            <div className="space-y-2" aria-label="Queue">
              {queue.data.items.map((i) => (
                <QueueItemCard key={i.caseResultId} runId={runId} item={i} onSaved={queue.reload} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
