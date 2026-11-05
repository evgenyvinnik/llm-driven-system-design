import { EscalatedBadge, HoldBadge, LateBadge } from '@/components/shared/Badges'
import { TierBadge } from '@/components/shared/TierBadge'
import { ClockIcon } from '@/components/icons'
import { ageText, dueText, kindText, ownerText, positionText } from '@/lib/format'
import { TIER_STYLE } from '@/lib/tiers'
import type { Alert } from '@/types'

interface Props {
  alert: Alert
  nowMs: number
  selected: boolean
  flash: boolean
  onSelect: () => void
}

export function AlertRow({ alert, nowMs, selected, flash, onSelect }: Props) {
  const acknowledged = alert.status === 'acknowledged' || alert.status === 'inspected'
  const due = alert.status === 'open' ? dueText(alert.ackDueAt, nowMs) : null
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`flex w-full items-start gap-3 border-l-4 px-4 py-3 text-left hover:bg-slate-50 ${TIER_STYLE[alert.tier]?.ring} ${selected ? 'bg-accent-50' : 'bg-white'} ${flash ? 'animate-flash' : ''} ${acknowledged || alert.status === 'closed' ? 'opacity-70' : ''}`}
        data-alert-id={alert.id}
      >
        <div className="w-24 shrink-0 pt-0.5">
          <TierBadge tier={alert.tier} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-sm font-semibold text-slate-900">{alert.carId}</span>
            <span className="text-sm text-slate-600">{kindText(alert.kind)}{alert.kind === 'hot_bearing' ? ` · ${positionText(alert.kind, alert.position)}` : ''}</span>
            <span className="text-sm text-slate-400">on</span>
            <span className="font-mono text-sm text-slate-700">{alert.symbol} {alert.direction}</span>
            {alert.escalatedAt && <EscalatedBadge />}
            {alert.late && <LateBadge lagSeconds={alert.dataLagSeconds} />}
            <HoldBadge status={alert.holdStatus} />
            {alert.status === 'acknowledged' && <span className="chip bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200">acknowledged by {alert.acknowledgedBy}</span>}
            {alert.status === 'inspected' && <span className="chip bg-sky-50 text-sky-800 ring-1 ring-sky-200">inspected · awaiting repair</span>}
            {due && (
              <span className={`chip ${due.overdue || alert.escalationLevel > 0 ? 'bg-red-50 text-red-800 ring-1 ring-red-200' : 'bg-slate-100 text-slate-600'}`}>
                <ClockIcon className="h-3 w-3" /> {alert.escalationLevel > 0 ? `unacknowledged · escalated to ${ownerText(alert.ownerRole, null, alert.escalationLevel)}` : due.text}
              </span>
            )}
            {alert.status === 'closed' && <span className="chip bg-slate-100 text-slate-600">closed: {alert.outcome?.replace(/_/g, ' ')}</span>}
          </div>
          <p className="mt-1 truncate text-sm text-slate-600">{alert.reasons[0]}</p>
        </div>
        <div className="w-44 shrink-0 text-right text-xs text-slate-500">
          <div className="font-medium text-slate-700">{ownerText(alert.ownerRole, alert.ownerId, 0)}{alert.ownerRole === 'dispatcher' && alert.yardId ? ` → ${alert.yardId}` : ''}</div>
          <div>{alert.escalatedAt ? `escalated ${ageText(alert.escalatedAt, nowMs)}` : `opened ${ageText(alert.openedAt, nowMs)}`}</div>
          <div>at {alert.triggerDetectorId}</div>
        </div>
      </button>
    </li>
  )
}
