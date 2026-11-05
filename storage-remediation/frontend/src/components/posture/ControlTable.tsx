import { Link } from '@tanstack/react-router'
import { SeverityBadge } from '@/components/shared'
import { num, pct } from '@/lib/format'
import type { ControlPosture, PosturePoint } from '@/types'
import { EvidenceBar, EvidenceLegend } from './EvidenceBar'
import { Sparkline } from './Sparkline'

function ComplianceBar({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 rounded-full bg-accent-100">
        <div className="h-2 rounded-full bg-accent-600" style={{ width: `${value}%` }} />
      </div>
      <span className="w-12 text-sm font-semibold text-slate-800">{pct(value)}</span>
    </div>
  )
}

export function ControlTable({ controls, history }: { controls: ControlPosture[]; history: PosturePoint[] }) {
  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-800">Controls</h2>
        <EvidenceLegend />
      </div>
      <table className="w-full">
        <thead className="bg-slate-50">
          <tr>
            <th className="th">Control</th>
            <th className="th">Severity</th>
            <th className="th">Compliance</th>
            <th className="th">Trend</th>
            <th className="th text-right">Open</th>
            <th className="th">Open by evidence</th>
            <th className="th text-right">Exempt</th>
            <th className="th">Policy</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {controls.map((c) => (
            <tr key={c.id} className="hover:bg-slate-50">
              <td className="td">
                <Link to="/findings" search={{ control: c.id }} className="font-medium text-slate-900 hover:text-accent-700">
                  <span className="font-mono text-xs text-slate-500">{c.id}</span> {c.title}
                </Link>
                <div className="text-xs text-slate-500">{c.breaking ? 'Can break callers: evidence required' : 'Additive: safe everywhere'}</div>
              </td>
              <td className="td"><SeverityBadge severity={c.severity} /></td>
              <td className="td">
                <ComplianceBar value={c.compliancePct} />
                <div className="text-xs text-slate-500">{num(c.compliant)} of {num(c.total)} accounts</div>
              </td>
              <td className="td"><Sparkline values={history.map((h) => h.controls[c.id]).filter((v) => v !== undefined)} label={c.id} /></td>
              <td className="td text-right font-semibold text-slate-800">
                {num(c.open)}
                {c.inRemediation > 0 && <div className="text-xs font-normal text-accent-700">{num(c.inRemediation)} in flight</div>}
              </td>
              <td className="td"><EvidenceBar counts={c.evidence} /></td>
              <td className="td text-right">{num(c.exempt)}</td>
              <td className="td"><span className={`chip ${c.policyEffect === 'deny' || c.policyEffect === 'modify' || c.policyEffect === 'deployIfNotExists' ? 'bg-green-50 text-green-800' : 'bg-slate-100 text-slate-600'}`}>{c.policyEffect}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
