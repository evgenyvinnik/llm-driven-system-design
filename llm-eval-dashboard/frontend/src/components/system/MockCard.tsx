import { api } from '@/services/api'
import type { MockState } from '@/types'

const KINDS = ['rate_limit', 'overloaded', 'timeout', 'disconnect', 'invalid'] as const

/** Call counters and armed-count chaos switches for one mock service. */
export function MockCard({ title, target, state, onChanged }: { title: string; target: 'model' | 'judge'; state: MockState | null; onChanged: () => void }) {
  if (!state) return <div className="card p-4 text-sm text-rose-700">{title} is not reachable.</div>
  const arm = (kind: string) => void api.armChaos(target, { [kind]: (state.chaos.armed[kind] ?? 0) + 1 }).then(onChanged)
  return (
    <div className="card space-y-3 p-4" aria-label={title}>
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-900">{title}</div>
        <button type="button" className="btn-ghost text-xs" onClick={() => void api.resetChaos(target).then(onChanged)}>
          Disarm all
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="panel-title">Calls</div>
          <div className="num text-xl font-semibold">{state.stats.total}</div>
        </div>
        <div>
          <div className="panel-title">Active</div>
          <div className="num text-xl font-semibold">{state.stats.active}</div>
        </div>
        <div>
          <div className="panel-title">Peak</div>
          <div className="num text-xl font-semibold">{state.stats.maxActive}</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1 text-[11px]">
        {Object.entries(state.stats.byOutcome).map(([k, v]) => (
          <span key={k} className="chip bg-slate-100 text-slate-700">
            {k}: {v}
          </span>
        ))}
      </div>
      <div>
        <div className="panel-title mb-1">Chaos (armed counts fail the next N calls)</div>
        <div className="flex flex-wrap gap-1.5">
          {KINDS.map((k) => (
            <button key={k} type="button" className="btn-secondary text-xs" onClick={() => arm(k)}>
              +1 {k} <span className="num text-slate-500">({state.chaos.armed[k] ?? 0} armed, {state.chaos.fired[k] ?? 0} fired)</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
