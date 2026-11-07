import { AlertIcon, CheckIcon, InfoIcon, XIcon } from '@/components/icons'
import type { Comparison } from '@/types'

const SEVERITY = {
  block: { tone: 'border-rose-200 bg-rose-50 text-rose-900', Icon: XIcon },
  warn: { tone: 'border-amber-200 bg-amber-50 text-amber-900', Icon: AlertIcon },
  info: { tone: 'border-slate-200 bg-slate-50 text-slate-700', Icon: InfoIcon },
}

/** Every pinned version side by side, what changed, and what that does to the claim. */
export function ProvenancePanel({ c }: { c: Comparison }) {
  const p = c.provenance
  const changed = p.rows.filter((r) => r.changed && r.role !== 'context').map((r) => r.label.toLowerCase())
  return (
    <div className="card space-y-3 p-4" aria-label="Provenance">
      <div className="flex items-center justify-between">
        <div className="panel-title">Provenance</div>
        <div className="text-xs text-slate-600">What changed: {changed.length > 0 ? changed.join(', ') : 'nothing (A/A)'}</div>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
            <th className="py-1 pr-2 font-semibold">Pin</th>
            <th className="py-1 pr-2 font-semibold">A · {c.a.name}</th>
            <th className="py-1 font-semibold">B · {c.b.name}</th>
          </tr>
        </thead>
        <tbody>
          {p.rows.map((r) => (
            <tr key={r.key} className={r.changed ? (r.role === 'must_match' ? 'bg-rose-50' : r.role === 'factor' ? 'bg-amber-50' : 'bg-slate-50') : ''}>
              <td className={`py-1 pr-2 text-xs ${r.role === 'context' ? 'pl-3 text-slate-500' : 'font-medium text-slate-700'}`}>{r.label}</td>
              <td className="py-1 pr-2 font-mono text-xs">{r.a}</td>
              <td className="py-1 font-mono text-xs">
                {r.b} {r.changed && <span className={`ml-1 text-[10px] font-semibold uppercase ${r.role === 'must_match' ? 'text-rose-700' : 'text-amber-700'}`}>{r.role === 'must_match' ? 'differs' : 'changed'}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="space-y-1.5" aria-label="Warnings">
        {p.warnings.map((w) => {
          const { tone, Icon } = SEVERITY[w.severity]
          return (
            <li key={w.code + w.message} className={`flex gap-2 rounded-md border px-3 py-2 text-xs ${tone}`}>
              <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                <b className="font-mono">{w.code}</b> {w.message}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** The checklist: what must hold before B can be called an improvement over A. */
export function RequirementsList({ c }: { c: Comparison }) {
  return (
    <div className="card p-4" aria-label="Requirements">
      <div className="panel-title mb-2">Before calling it an improvement</div>
      <ul className="space-y-1.5">
        {c.provenance.requirements.map((r) => (
          <li key={r.key} className="flex items-start gap-2 text-sm">
            {r.met === true ? <CheckIcon className="mt-0.5 h-4 w-4 text-emerald-600" /> : r.met === false ? <XIcon className="mt-0.5 h-4 w-4 text-rose-600" /> : <InfoIcon className="mt-0.5 h-4 w-4 text-slate-400" />}
            <span>
              {r.label} <span className="text-xs text-slate-500">({r.detail})</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
