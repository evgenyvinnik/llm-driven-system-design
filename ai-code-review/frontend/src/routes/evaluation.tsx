import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { Comparison } from '@/components/evaluation/Comparison'
import { CaseTable, ClassTable, VersionTable } from '@/components/evaluation/Tables'
import { Empty, ErrorNote, Loading } from '@/components/shared/Loading'
import { pct } from '@/lib/format'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'
import { canAdmin, useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/evaluation')({ component: EvaluationPage })

function EvaluationPage() {
  const user = useAuthStore((s) => s.user)
  const [version, setVersion] = useState('mock-reviewer-1')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const list = usePoll(() => api.evaluations(), 10000)
  const full = list.data?.evaluations.filter((e) => !e.partial && e.status === 'completed') ?? []
  const latestByVersion = (list.data?.modelVersions ?? []).map((v) => full.find((e) => e.modelVersion === v)).filter((e) => e !== undefined)
  const current = full.find((e) => e.modelVersion === version)
  const detail = usePoll(() => (current ? api.evaluation(current.id) : Promise.resolve(null)), 30000, [current?.id])

  async function run() {
    setBusy(true)
    setActionError(null)
    try {
      await api.runEvaluation(version)
      list.reload()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'The evaluation failed')
    } finally {
      setBusy(false)
    }
  }

  const summary = current?.summary
  return (
    <div className="page !max-w-7xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="h1">Evaluation against labeled history</h1>
          <p className="max-w-3xl text-sm text-slate-500">The same committed corpus, replayed through the flawed proposal and the corrected design. Zero observed is not zero: the upper bound is what the sample can actually support, and the corpus was written by the gate's author.</p>
        </div>
        <div className="flex items-center gap-2">
          <select aria-label="Model version" className="input !w-48" value={version} onChange={(e) => setVersion(e.target.value)}>
            {list.data?.modelVersions.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          {canAdmin(user) && <button type="button" className="btn-primary" disabled={busy} onClick={() => void run()}>{busy ? 'Replaying…' : 'Replay the corpus'}</button>}
        </div>
      </div>
      {actionError && <ErrorNote message={actionError} />}
      {list.error && <ErrorNote message={list.error} />}
      {list.loading && !list.data ? <Loading /> : summary ? (
        <>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-600" aria-label="Corpus">
            <span><b className="num">{summary.corpus.size}</b> labeled PRs</span>
            <span><b className="num">{summary.corpus.dangerous}</b> dangerous</span>
            <span><b className="num">{summary.corpus.injections}</b> injections</span>
            <span><b className="num">{summary.corpus.humanRejected}</b> rejected by humans</span>
            <span>Shadow agreement with humans <b className="num">{pct(summary.observe.humanAgreement.rate)}</b></span>
            <span className="font-mono text-xs text-slate-400">corpus {current?.corpusHash.slice(0, 10)}</span>
          </div>
          <Comparison summary={summary} />
          <h2 className="panel-title">Per model version</h2>
          <VersionTable evaluations={latestByVersion} />
          <h2 className="panel-title">Per class of change</h2>
          <ClassTable rows={summary.byClass} />
          {detail.data && <CaseTable cases={detail.data.cases} />}
        </>
      ) : <Empty>No full evaluation for this model version yet.</Empty>}
    </div>
  )
}
