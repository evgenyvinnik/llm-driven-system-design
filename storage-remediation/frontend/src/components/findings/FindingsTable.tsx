import { Link } from '@tanstack/react-router'
import { EvidenceBadge, SeverityBadge } from '@/components/shared'
import { relativeTime, valueText } from '@/lib/format'
import type { Finding } from '@/types'

function Due({ iso, status }: { iso: string | null; status: string }) {
  if (!iso || status !== 'open') return <span className="text-slate-400">—</span>
  const overdue = Date.parse(iso) < Date.now()
  return <span className={overdue ? 'font-medium text-red-700' : 'text-slate-600'}>{overdue ? `overdue ${relativeTime(iso).replace(' ago', '')}` : relativeTime(iso)}</span>
}

export function FindingsTable({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) return <div className="card p-8 text-center text-sm text-slate-500">No findings match these filters.</div>
  return (
    <div className="card overflow-x-auto">
      <table className="w-full" aria-label="Findings">
        <thead className="bg-slate-50">
          <tr>
            <th className="th">Account</th>
            <th className="th">Control</th>
            <th className="th">Severity</th>
            <th className="th text-right">Risk</th>
            <th className="th">Observed</th>
            <th className="th">Evidence</th>
            <th className="th">Owner</th>
            <th className="th">Due</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {findings.map((f) => (
            <tr key={f.id} className="hover:bg-slate-50">
              <td className="td">
                <Link to="/accounts/$name" params={{ name: f.accountName }} className="font-mono text-[13px] font-medium text-accent-700 hover:underline">{f.accountName}</Link>
                <div className="text-xs text-slate-500">{f.subscriptionName} · {f.environment}{f.dataClassification ? ` · ${f.dataClassification}` : ''}</div>
              </td>
              <td className="td">
                <span className="font-mono text-xs text-slate-500">{f.controlId}</span> {f.controlTitle}
                <div className="flex gap-1">
                  {f.inRemediation && <span className="chip mt-0.5 bg-accent-50 text-accent-800">in campaign</span>}
                  {f.status === 'exempt' && <span className="chip mt-0.5 bg-slate-100 text-slate-600">exempt</span>}
                  {f.reopenedCount > 0 && <span className="chip mt-0.5 bg-amber-50 text-amber-800">regressed {f.reopenedCount}×</span>}
                </div>
              </td>
              <td className="td"><SeverityBadge severity={f.severity} /></td>
              <td className="td text-right font-semibold text-slate-800">{f.riskScore}</td>
              <td className="td font-mono text-xs">{valueText(f.observed)}</td>
              <td className="td max-w-[18rem]">
                <EvidenceBadge value={f.evidenceClass} />
                {f.evidenceReason && <div className="mt-0.5 text-xs text-slate-500">{f.evidenceReason}</div>}
              </td>
              <td className="td">
                {f.owner ?? <span className="text-red-700">no owner</span>}
                {f.ownerSource === 'subscription' && <div className="text-xs text-slate-400">from subscription</div>}
              </td>
              <td className="td text-xs"><Due iso={f.dueAt} status={f.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
