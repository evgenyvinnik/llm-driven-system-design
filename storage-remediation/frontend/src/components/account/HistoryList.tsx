import { Link } from '@tanstack/react-router'
import { dateTime, valueText } from '@/lib/format'
import type { AuditEntry } from '@/types'

export function HistoryList({ entries }: { entries: AuditEntry[] }) {
  return (
    <div className="card p-4">
      <h2 className="text-sm font-semibold text-slate-800">Change history</h2>
      {entries.length === 0 && <p className="mt-2 text-sm text-slate-500">No changes recorded.</p>}
      <ol className="mt-2 space-y-2">
        {entries.map((e) => (
          <li key={e.id} className="border-l-2 border-slate-200 pl-3 text-sm">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium text-slate-800">{e.action}</span>
              {e.controlId && <span className="font-mono text-xs text-slate-500">{e.controlId}</span>}
              <span className="text-xs text-slate-400">{dateTime(e.at)} · {e.actor}</span>
            </div>
            {(e.before !== null || e.after !== null) && (
              <div className="font-mono text-xs text-slate-600">{e.before === null ? `now ${valueText(e.after)}` : `${valueText(e.before)} → ${valueText(e.after)}`}</div>
            )}
            {typeof e.details.reason === 'string' && <div className="text-xs text-slate-500">{e.details.reason}</div>}
            {e.campaignId && (
              <Link to="/campaigns/$campaignId" params={{ campaignId: e.campaignId }} className="text-xs text-accent-700 hover:underline">view campaign</Link>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}
