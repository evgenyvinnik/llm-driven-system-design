import { useEffect, useState } from 'react'
import { percent, relativeTime } from '@/lib/format'
import { api } from '@/services/api'
import type { EvalRun } from '@/types'

/** The latest `npm run eval` result: saved scenarios replayed through the real orchestrator. */
export function EvalPanel() {
  const [run, setRun] = useState<EvalRun | null | undefined>(undefined)
  useEffect(() => {
    api.adminEvals().then((r) => setRun(r.run)).catch(() => setRun(null))
  }, [])
  if (run === undefined) return null
  if (!run) return <div className="card p-3 text-xs text-slate-500">No eval runs yet. Run <code>npm run eval</code> in backend/.</div>
  return (
    <div className="card p-3">
      <div className="panel-title mb-2">Eval · {run.model} · {relativeTime(run.createdAt)}</div>
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-700">
        <span><b>{run.summary.passed}/{run.summary.tasks}</b> passed</span>
        <span>right first tool <b>{percent(run.summary.firstToolCorrectRate)}</b></span>
        <span>valid args <b>{percent(run.summary.validArgsRate)}</b></span>
        <span><b>{run.summary.avgToolCalls.toFixed(1)}</b> calls/task</span>
        <span><b>{Math.round(run.summary.avgTokens)}</b> tokens/task</span>
      </div>
      <ul className="space-y-0.5 text-xs">
        {run.results.map((r) => (
          <li key={r.task} className="flex gap-2">
            <span className={r.passed ? 'text-emerald-600' : 'text-red-600'}>{r.passed ? 'PASS' : 'FAIL'}</span>
            <span className="text-slate-700">{r.task}</span>
            <span className="truncate text-slate-400">{r.tools.join(' → ')}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
