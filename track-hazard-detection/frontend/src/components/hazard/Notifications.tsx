import { msText, timeText } from '@/lib/format'
import type { Notification } from '@/types'

export function Notifications({ rows }: { rows: Notification[] }) {
  if (rows.length === 0) return <p className="px-4 py-4 text-sm text-slate-500">No notifications sent for this hazard.</p>
  return (
    <ul className="divide-y divide-slate-100 text-sm" aria-label="Notifications">
      {rows.map((n) => (
        <li key={n.id} className="flex items-center gap-3 px-4 py-2">
          <span className="chip w-16 justify-center bg-slate-100 text-slate-700">{n.channel}</span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-slate-800" title={n.message}>
              <b>{n.recipient}</b> · {n.message}
            </div>
            <div className="text-xs text-slate-500">
              {n.eventType} · sent {timeText(n.createdAt)}
              {n.deliveredAt && ` · delivered in ${msText(Date.parse(n.deliveredAt) - Date.parse(n.createdAt))}`}
              {n.attempts > 1 && ` · ${n.attempts} attempts`}
            </div>
          </div>
          <span className={`chip ${n.status === 'delivered' ? 'bg-emerald-50 text-emerald-700' : n.status === 'failed' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'}`}>{n.status}</span>
        </li>
      ))}
    </ul>
  )
}
