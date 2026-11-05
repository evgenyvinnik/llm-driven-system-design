import { Link } from '@tanstack/react-router'
import { dateTime, valueText } from '@/lib/format'
import type { AuditEntry } from '@/types'

function detailText(d: Record<string, unknown>): string {
  if (typeof d.reason === 'string') return d.reason
  if (typeof d.outcome === 'string' && d.outcome !== 'written') return `outcome: ${d.outcome.replaceAll('_', ' ')}`
  if (typeof d.name === 'string') return d.name
  if (typeof d.justification === 'string') return d.justification
  return ''
}

export function AuditTable({ entries }: { entries: AuditEntry[] }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full" aria-label="Audit log">
        <thead className="bg-slate-50">
          <tr>
            <th className="th">When</th>
            <th className="th">Actor</th>
            <th className="th">Action</th>
            <th className="th">Resource</th>
            <th className="th">Before → after</th>
            <th className="th">Detail</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {entries.map((e) => (
            <tr key={e.id}>
              <td className="td whitespace-nowrap font-mono text-xs text-slate-500">{dateTime(e.at)}</td>
              <td className="td text-xs">{e.actor}</td>
              <td className="td text-xs font-medium text-slate-800">{e.action}{e.controlId && <span className="ml-1 font-mono text-slate-500">{e.controlId}</span>}</td>
              <td className="td text-xs">
                {e.accountName ? <Link to="/accounts/$name" params={{ name: e.accountName }} className="font-mono text-accent-700 hover:underline">{e.accountName}</Link> : null}
                {e.campaignId && <div><Link to="/campaigns/$campaignId" params={{ campaignId: e.campaignId }} className="text-slate-500 hover:underline">campaign</Link></div>}
              </td>
              <td className="td font-mono text-xs">{e.before !== null || e.after !== null ? `${valueText(e.before)} → ${valueText(e.after)}` : ''}</td>
              <td className="td max-w-md text-xs text-slate-500">{detailText(e.details)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
