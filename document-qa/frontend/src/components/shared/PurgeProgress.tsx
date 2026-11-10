/** "purged 3/5" with one chip per artifact; used by the library and the ops page. */
import { time } from '@/lib/format'
import type { PurgeState } from '@/types'
import { ProgressBar } from './Chips'

export function PurgeProgress({ purge, completedAt }: { purge: PurgeState | null; completedAt: string | null }) {
  if (!purge) return <span className="text-xs text-slate-500">Purge not started</span>
  const complete = completedAt !== null
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-semibold text-slate-700">
          purged {purge.done}/{purge.total}
        </span>
        <span className="text-slate-500">{complete ? `completed ${time(completedAt)}` : purge.lastError ? 'retrying' : 'in progress'}</span>
      </div>
      <ProgressBar done={purge.done} total={purge.total} tone={complete ? 'green' : purge.lastError ? 'amber' : 'accent'} />
      <div className="flex flex-wrap gap-1">
        {purge.artifacts.map((a) => (
          <span
            key={a.artifact}
            className={`chip ring-1 ring-inset ${a.status === 'done' ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : a.lastError ? 'bg-amber-50 text-amber-800 ring-amber-200' : 'bg-slate-100 text-slate-600 ring-slate-200'}`}
            title={a.lastError ? `${a.lastError} (attempt ${a.attempts})` : a.completedAt ? `done ${time(a.completedAt)}` : 'pending'}
          >
            {a.artifact}
            {a.status === 'done' ? <span className="num font-normal">−{a.removed}</span> : a.lastError ? <span className="font-normal">retry {a.attempts}</span> : null}
          </span>
        ))}
      </div>
      {!complete && purge.lastError && <div className="text-xs text-amber-800">{purge.lastError}</div>}
    </div>
  )
}
