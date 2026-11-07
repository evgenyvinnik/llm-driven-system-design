import { createFileRoute } from '@tanstack/react-router'
import { ScorerCard } from '@/components/scorers/ScorerCard'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'

export const Route = createFileRoute('/scorers')({ component: ScorersPage })

function ScorersPage() {
  const { data, error, reload } = usePoll(() => api.scorers(), 15_000)
  return (
    <div className="page">
      <div>
        <h1 className="h1">Scorers</h1>
        <p className="text-sm text-slate-500">Scores from different scorer versions are never compared with each other. Fix a scorer by saving a new version, then re-score old runs from their stored outputs.</p>
      </div>
      {error && <ErrorNote message={error} />}
      {!data ? (
        <Loading />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2" aria-label="Scorers">
          {data.scorers.map((s) => (
            <ScorerCard key={s.id} scorer={s} onSaved={reload} />
          ))}
        </div>
      )}
    </div>
  )
}
