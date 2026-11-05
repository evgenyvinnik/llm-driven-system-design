import { LifecycleChip } from '@/components/shared/Chips'
import { money, simTime, titleCase } from '@/lib/format'
import type { Evaluation, PlanVersion } from '@/types'

const DECISION: Record<string, string> = {
  initial: 'First plan',
  switch_unsafe: 'Replaced: unsafe',
  switch_savings: 'Replaced: cheaper',
  propose_change: 'Proposed change',
  keep_same: 'Kept: same stops',
  keep_within_band: 'Kept: within band',
}

/** Why the plan is what it is: every version, and every evaluation that kept or changed it. */
export function HistoryPanel({ versions, evaluations }: { versions: PlanVersion[]; evaluations: Evaluation[] }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="card p-4">
        <div className="panel-title mb-2">Plan versions</div>
        <ol className="space-y-2.5">
          {versions.map((v) => (
            <li key={v.version} className="text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-slate-900">v{v.version}</span>
                <LifecycleChip lifecycle={v.lifecycle} />
                <span className="text-xs text-slate-500">{simTime(v.createdAt)} · {titleCase(v.trigger)}</span>
                <span className="num ml-auto text-xs text-slate-600">{money(v.costTotal)}</span>
              </div>
              <div className="text-xs text-slate-700">{v.signature}</div>
              <div className="text-xs text-slate-500">{v.reason}</div>
            </li>
          ))}
        </ol>
      </div>
      <div className="card p-4">
        <div className="panel-title mb-2">Recent evaluations (including the ones that changed nothing)</div>
        <ol className="space-y-2">
          {evaluations.slice(0, 10).map((e) => (
            <li key={e.id} className="text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-slate-800">{DECISION[e.decision] ?? e.decision}</span>
                <span className="text-xs text-slate-500">
                  {simTime(e.evaluatedAt)} · {titleCase(e.trigger)}
                  {e.triggerDetail ? ` (${e.triggerDetail})` : ''}
                </span>
                <span className="num ml-auto text-[11px] text-slate-400">{e.durationMs.toFixed(0)} ms</span>
              </div>
              <div className="text-xs text-slate-600">{e.explanation}</div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
