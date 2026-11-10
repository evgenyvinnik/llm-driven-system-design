import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { ScaleIcon, XIcon } from '@/components/icons'
import { ErrorNote } from '@/components/shared/Loading'
import { api } from '@/services/api'
import type { RunScorer, Scorer } from '@/types'

/**
 * Re-scoring reads the run's stored outputs and writes new score rows for the
 * chosen scorer version. No generation task is created: the model gets zero
 * calls, and the old scores stay next to the new ones.
 */
export function RescoreDialog({ runId, attached, modelCalls, onClose, onDone }: { runId: string; attached: RunScorer[]; modelCalls: number; onClose: () => void; onDone: () => void }) {
  const [scorers, setScorers] = useState<Scorer[] | null>(null)
  const [choice, setChoice] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void api.scorers().then((r) => setScorers(r.scorers.filter((s) => s.kind !== 'human')))
  }, [])
  const taken = new Set(attached.map((a) => a.scorerVersionId))
  const options = (scorers ?? []).flatMap((s) => s.versions.filter((v) => !taken.has(v.id)).map((v) => ({ id: v.id, label: `${s.name} v${v.version}: ${v.message}` })))

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const r = await api.rescore(runId, choice)
      setResult(`Queued ${r.queued} score tasks over stored outputs (${r.alreadyScored} already had this version). Model calls for this run stay at ${modelCalls}.`)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Re-score failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-label="Re-score run">
      <div className="card w-full max-w-lg space-y-4 p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900">Re-score stored outputs</h2>
          <button type="button" className="btn-ghost p-1" onClick={onClose} aria-label="Close">
            <XIcon />
          </button>
        </div>
        <p className="text-sm text-slate-600">
          Pick a scorer version that isn't on this run yet. Outputs are not generated again; existing scores are kept. To fix a regex or tighten a rubric, first{' '}
          <Link to="/scorers" className="text-accent-700 hover:underline">
            create a new scorer version
          </Link>
          .
        </p>
        <select className="input" value={choice} onChange={(e) => setChoice(e.target.value)} aria-label="Scorer version">
          <option value="">Choose a scorer version…</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        {result && <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{result}</div>}
        {error && <ErrorNote message={error} />}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn-primary" disabled={!choice || busy || result !== null} onClick={() => void submit()}>
            <ScaleIcon /> Re-score
          </button>
        </div>
      </div>
    </div>
  )
}
