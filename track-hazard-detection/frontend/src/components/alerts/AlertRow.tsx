import { Link } from '@tanstack/react-router'
import { CheckIcon } from '@/components/icons'
import { LateBadge, SeverityBadge } from '@/components/shared/Badges'
import { ageText, countdown, KIND_LABEL, mpText } from '@/lib/format'
import { useCommand } from '@/lib/useCommand'
import type { AlertRow as Row } from '@/types'

export function AlertRow({ alert: a, now, canAck, onDone }: { alert: Row; now: number; canAck: boolean; onDone: () => void }) {
  const { run, busy, error } = useCommand(a.hazardId, a.version, onDone)
  const due = a.status === 'open' ? countdown(a.ackDeadlineAt, now) : null
  return (
    <li className={`flex items-center gap-3 px-4 py-3 ${a.status === 'open' ? (due?.overdue ? 'bg-red-50/60' : '') : 'opacity-75'}`}>
      <SeverityBadge severity={a.alertSeverity ?? a.severity} />
      <div className="min-w-0 flex-1">
        <Link to="/hazards/$hazardId" params={{ hazardId: a.hazardId }} className="flex items-center gap-2 text-sm font-medium text-slate-900 hover:text-accent-700">
          {a.alertId} · {KIND_LABEL[a.kind]} · {mpText(a.mpFrom, a.mpTo)} ({a.subdivisionId})
          <LateBadge late={a.late} />
        </Link>
        <div className="text-xs text-slate-500">
          {a.deskId} desk · {a.assignee ?? 'unassigned'} · issued {ageText(a.issuedAt, now)}
          {a.escalationLevel > 0 && <span className="ml-1 font-medium text-red-700">· escalated L{a.escalationLevel} to {a.escalationTarget}</span>}
          {a.inspectorName && ` · inspector ${a.inspectorName}`}
          {a.status !== 'closed' && a.alertSeverity && a.severity !== a.alertSeverity && <span className="ml-1 font-medium text-slate-700">· hazard now {a.severity} (re-assessed)</span>}
        </div>
        {error && <div className="text-xs text-red-600">{error}</div>}
      </div>
      <div className="w-40 text-right text-xs">
        {a.status === 'open' && due && <span className={due.overdue ? 'font-semibold text-red-600' : 'text-slate-600'}>ack {due.text}</span>}
        {a.status === 'acknowledged' && <span className="text-emerald-700">ack by {a.acknowledgedBy}</span>}
        {a.status === 'closed' && <span className="text-slate-500">{a.outcome === 'false_alarm' ? 'false alarm' : 'cleared'}</span>}
      </div>
      {canAck && a.status === 'open' ? (
        <button type="button" className="btn-primary" disabled={!!busy} onClick={() => void run({ kind: 'acknowledge' })}>
          <CheckIcon /> Ack
        </button>
      ) : (
        <span className="w-[66px]" />
      )}
    </li>
  )
}
