import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { ComparePicker } from '@/components/compare/ComparePicker'
import { CompareCaseTable } from '@/components/compare/CompareCaseTable'
import { ProvenancePanel, RequirementsList } from '@/components/compare/ProvenancePanel'
import { VerdictCard } from '@/components/compare/VerdictCard'
import { Empty, ErrorNote, Loading } from '@/components/shared/Loading'
import { api } from '@/services/api'
import type { Comparison, RunListItem, Scorer } from '@/types'

interface Search {
  a?: string
  b?: string
  scorer?: string
}

export const Route = createFileRoute('/compare')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    a: typeof s.a === 'string' ? s.a : undefined,
    b: typeof s.b === 'string' ? s.b : undefined,
    scorer: typeof s.scorer === 'string' ? s.scorer : undefined,
  }),
  component: ComparePage,
})

function ComparePage() {
  const search = Route.useSearch()
  const navigate = useNavigate()
  const [runs, setRuns] = useState<RunListItem[]>([])
  const [scorers, setScorers] = useState<Scorer[]>([])
  const [result, setResult] = useState<Comparison | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    void Promise.all([api.runs(), api.scorers()]).then(([r, s]) => {
      setRuns(r.runs)
      setScorers(s.scorers)
    })
  }, [])

  const load = useCallback(async () => {
    if (!search.a || !search.b || !search.scorer) return setResult(null)
    setLoading(true)
    setError(null)
    try {
      setResult(await api.compare(search.a, search.b, search.scorer))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Comparison failed')
    } finally {
      setLoading(false)
    }
  }, [search.a, search.b, search.scorer])
  useEffect(() => {
    void load()
  }, [load])

  async function rescore(runId: string, scorerVersionId: string) {
    const r = await api.rescore(runId, scorerVersionId)
    setNote(`Queued ${r.queued} score tasks on stored outputs; reloading when they finish.`)
    window.setTimeout(() => void load(), 2500)
  }

  return (
    <div className="page max-w-7xl">
      <div>
        <h1 className="h1">Compare runs</h1>
        <p className="text-sm text-slate-500">Paired by case on the same dataset version. The verdict says "improvement" only when every requirement on the right holds.</p>
      </div>
      <ComparePicker runs={runs} scorers={scorers} a={search.a} b={search.b} scorer={search.scorer} onChange={(next) => void navigate({ to: '/compare', search: next })} />
      {note && <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{note}</div>}
      {error && <ErrorNote message={error} />}
      {loading && !result && <Loading label="Comparing…" />}
      {!search.a || !search.b || !search.scorer ? (
        <Empty>Pick two runs and a scorer.</Empty>
      ) : (
        result && (
          <>
            <VerdictCard c={result} onRescore={(runId, sv) => void rescore(runId, sv)} />
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <ProvenancePanel c={result} />
              </div>
              <RequirementsList c={result} />
            </div>
            <CompareCaseTable cases={result.cases} />
          </>
        )
      )}
    </div>
  )
}
