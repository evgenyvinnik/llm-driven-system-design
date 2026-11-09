import { RuleIcon } from '@/components/shared/Chips'
import { RULE_LABEL } from '@/lib/format'
import type { GateResult } from '@/types'

export function GateChecklist({ gate, sha }: { gate: GateResult | null; sha: string }) {
  if (!gate) return <div className="card p-4 text-sm text-slate-500">No gate result for this decision yet.</div>
  return (
    <section aria-label="Gate checklist" className="card p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="panel-title">Policy gate at {sha.slice(0, 7)}</h2>
        <span className="text-xs text-slate-500">policy {gate.policyVersion} · category <code className="code">{gate.category}</code></span>
      </div>
      <ul className="space-y-2">
        {gate.rules.map((r) => (
          <li key={r.id} className="flex gap-2 text-sm">
            <span className="mt-0.5 shrink-0"><RuleIcon status={r.status} /></span>
            <div className="min-w-0">
              <div className={`font-medium ${r.status === 'fail' ? 'text-rose-800' : r.status === 'unknown' ? 'text-amber-800' : 'text-slate-800'}`}>{RULE_LABEL[r.id] ?? r.id}</div>
              <div className="break-words text-xs text-slate-500">{r.reason}</div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
