import { useState } from 'react'
import { Chip } from '@/components/shared/Chips'
import { humanize, pct } from '@/lib/format'
import type { ClassRow, Evaluation, EvaluationCase } from '@/types'

export function VersionTable({ evaluations }: { evaluations: Evaluation[] }) {
  return (
    <div className="card overflow-x-auto">
      <table aria-label="Per model version" className="w-full">
        <thead><tr><th className="th">Model version</th><th className="th">Policy</th><th className="th">Model only: dangerous approved</th><th className="th">Model + gate: dangerous approved</th><th className="th">Upper bound</th><th className="th">False escalations</th><th className="th">Shadow agreement</th></tr></thead>
        <tbody>
          {evaluations.map((e) => {
            const s = e.summary
            if (!s) return null
            return (
              <tr key={e.id} className="border-t border-slate-100">
                <td className="td font-medium">{e.modelVersion}</td>
                <td className="td text-xs">{e.policyVersion}</td>
                <td className="td num text-rose-700">{s.modelOnly.dangerous.falseApprovals} / {s.modelOnly.dangerous.total}</td>
                <td className="td num text-emerald-700">{s.modelPlusGate.dangerous.falseApprovals} / {s.modelPlusGate.dangerous.total}</td>
                <td className="td num">{pct(s.modelPlusGate.dangerous.upperBound95)}</td>
                <td className="td num">{s.modelPlusGate.falseEscalations.count} / {s.modelPlusGate.falseEscalations.total}</td>
                <td className="td num">{pct(s.observe.humanAgreement.rate)}, {s.observe.humanAgreement.unsafeDisagreements} unsafe</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function ClassTable({ rows }: { rows: ClassRow[] }) {
  return (
    <div className="card overflow-x-auto">
      <table aria-label="By class" className="w-full">
        <thead><tr><th className="th">Class</th><th className="th">Cases</th><th className="th">Dangerous</th><th className="th">Approved, model only</th><th className="th">Approved, model + gate</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.class} className="border-t border-slate-100">
              <td className="td">{humanize(r.class)}</td>
              <td className="td num">{r.total}</td>
              <td className="td num">{r.dangerous}</td>
              <td className={`td num ${r.dangerous > 0 && r.modelOnlyApproved > 0 ? 'font-semibold text-rose-700' : ''}`}>{r.modelOnlyApproved}</td>
              <td className={`td num ${r.dangerous > 0 && r.gatedApproved > 0 ? 'font-semibold text-rose-700' : ''}`}>{r.gatedApproved}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function CaseTable({ cases }: { cases: EvaluationCase[] }) {
  const [filter, setFilter] = useState<'dangerous' | 'injection' | 'false_escalation' | 'all'>('injection')
  const shown = cases.filter((c) => (filter === 'all' ? true : filter === 'dangerous' ? c.dangerous : filter === 'injection' ? c.injection : !c.dangerous && c.humanDecision === 'approve' && c.gated !== 'approved'))
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="panel-title">Cases</h2>
        <select aria-label="Case filter" className="input !w-52" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="injection">Injections</option>
          <option value="dangerous">Dangerous</option>
          <option value="false_escalation">False escalations</option>
          <option value="all">All</option>
        </select>
      </div>
      <div className="card overflow-x-auto">
        <table aria-label="Cases" className="w-full">
          <thead><tr><th className="th">Case</th><th className="th">Label</th><th className="th">Model</th><th className="th">Model only</th><th className="th">Model + gate</th><th className="th">Why</th></tr></thead>
          <tbody>
            {shown.map((c) => (
              <tr key={c.caseId} className="border-t border-slate-100">
                <td className="td"><div className="font-medium">{c.title}</div><div className="text-xs text-slate-400">{c.caseId}</div></td>
                <td className="td">{c.dangerous ? <Chip tone="bad">dangerous</Chip> : <Chip>safe</Chip>}{c.injection && <div className="mt-1"><Chip tone="warn">injection</Chip></div>}</td>
                <td className="td text-xs">{c.modelVerdict.replace('_', ' ')}{c.modelConfidence !== null ? ` ${Number(c.modelConfidence).toFixed(2)}` : ''}</td>
                <td className="td text-xs">{c.modelOnly}</td>
                <td className="td text-xs">{c.gated}</td>
                <td className="td max-w-md break-words text-xs text-slate-500">{c.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
