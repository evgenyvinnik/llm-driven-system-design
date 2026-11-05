/**
 * Delivered is not acknowledged, and inspected is not closed. Each step shows
 * when it happened; the current owner and the acknowledgment deadline sit under it.
 */
import { CheckIcon, ClockIcon } from '@/components/icons'
import { dueText, ownerText, timeText } from '@/lib/format'
import type { Alert } from '@/types'

export function Lifecycle({ alert, nowMs }: { alert: Alert; nowMs: number }) {
  const steps: Array<[string, string | null]> = [
    ['Opened', alert.openedAt],
    ['Delivered', alert.deliveredAt],
    ['Acknowledged', alert.acknowledgedAt],
    ['Inspected', alert.inspectedAt],
    ['Closed', alert.closedAt],
  ]
  const due = alert.status === 'open' ? dueText(alert.ackDueAt, nowMs) : null
  return (
    <div className="space-y-2">
      <ol className="flex items-start" aria-label="Alert lifecycle">
        {steps.map(([label, at], i) => (
          <li key={label} className="flex flex-1 flex-col items-center text-center">
            <div className="flex w-full items-center">
              <div className={`h-0.5 flex-1 ${i === 0 ? 'opacity-0' : at ? 'bg-slate-700' : 'bg-slate-200'}`} />
              <span className={`flex h-6 w-6 items-center justify-center rounded-full ${at ? 'bg-slate-800 text-white' : 'border border-slate-300 bg-white text-slate-300'}`}>
                {at ? <CheckIcon className="h-3.5 w-3.5" /> : <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />}
              </span>
              <div className={`h-0.5 flex-1 ${i === steps.length - 1 ? 'opacity-0' : steps[i + 1][1] ? 'bg-slate-700' : 'bg-slate-200'}`} />
            </div>
            <span className="mt-1 text-[11px] font-medium text-slate-700">{label}</span>
            <span className="text-[10px] text-slate-400">{at ? timeText(at) : '—'}</span>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-slate-500">Owner:</span>
        <span className="font-medium text-slate-800">{ownerText(alert.ownerRole, alert.ownerId, alert.escalationLevel)}</span>
        {alert.escalationLevel > 0 && <span className="chip bg-red-50 text-red-800 ring-1 ring-red-200">escalated ×{alert.escalationLevel}</span>}
        {due && (
          <span className={`chip ${due.overdue ? 'bg-red-50 text-red-800 ring-1 ring-red-200' : 'bg-slate-100 text-slate-700'}`}>
            <ClockIcon className="h-3 w-3" /> {due.text}
          </span>
        )}
        {alert.deliveredAt && alert.status === 'open' && <span className="text-slate-500">Delivered, not yet acknowledged.</span>}
      </div>
    </div>
  )
}
