import { Severity } from '@/components/shared/Chips'
import { simTime, titleCase } from '@/lib/format'
import { api } from '@/services/api'
import type { AlertRow } from '@/types'

export function AlertList({ alerts, selected, onSelect, canAck, onChanged }: { alerts: AlertRow[]; selected: number | null; onSelect: (a: AlertRow) => void; canAck: boolean; onChanged: () => void }) {
  if (alerts.length === 0) return <div className="card p-4 text-sm text-slate-600">No open alerts.</div>
  return (
    <ul className="card divide-y divide-slate-100" aria-label="Alerts">
      {alerts.map((a) => (
        <li key={a.id} className={`cursor-pointer px-4 py-3 hover:bg-slate-50 ${selected === a.id ? 'bg-accent-50' : ''}`} onClick={() => onSelect(a)}>
          <div className="flex flex-wrap items-center gap-2">
            <Severity severity={a.severity} />
            <span className="text-sm font-medium text-slate-900">{titleCase(a.type)}</span>
            <span className="text-xs text-slate-500">
              {a.symbol ?? 'Fleet'}
              {a.locomotiveId ? ` · unit ${a.locomotiveId}` : ''} · {simTime(a.raisedAt)}
            </span>
            <div className="flex-1" />
            {a.status === 'acknowledged' ? (
              <span className="text-xs text-slate-500">Acknowledged by {a.acknowledgedBy}</span>
            ) : (
              canAck && (
                <button
                  type="button"
                  className="btn-secondary px-2 py-1 text-xs"
                  onClick={(e) => {
                    e.stopPropagation()
                    void api.ackAlert(a.id).then(onChanged)
                  }}
                >
                  Acknowledge
                </button>
              )
            )}
          </div>
          <p className="mt-1 text-sm text-slate-700">{a.message}</p>
        </li>
      ))}
    </ul>
  )
}
