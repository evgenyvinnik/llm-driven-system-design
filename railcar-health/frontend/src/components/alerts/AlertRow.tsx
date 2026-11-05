import { EscalatedBadge, HoldBadge, LateBadge } from '@/components/shared/Badges'
import { TierBadge } from '@/components/shared/TierBadge'
import { ageText, positionText, routingText } from '@/lib/format'
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
  const acknowledged = alert.status === 'acknowledged'
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
            <span className="text-sm text-slate-600">{alert.kind === 'hot_wheel' ? 'hot wheels' : 'hot bearing'} · {positionText(alert.kind, alert.position)}</span>
            <span className="text-sm text-slate-400">on</span>
            <span className="font-mono text-sm text-slate-700">{alert.symbol} {alert.direction}</span>
            {alert.escalatedAt && <EscalatedBadge />}
            {alert.late && <LateBadge lagSeconds={alert.dataLagSeconds} />}
            <HoldBadge status={alert.holdStatus} />
            {acknowledged && <span className="chip bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200">acknowledged by {alert.acknowledgedBy}</span>}
            {alert.status === 'closed' && <span className="chip bg-slate-100 text-slate-600">closed: {alert.outcome?.replace(/_/g, ' ')}</span>}
          </div>
          <p className="mt-1 truncate text-sm text-slate-600">{alert.reasons[0]}</p>
        </div>
        <div className="w-44 shrink-0 text-right text-xs text-slate-500">
          <div className="font-medium text-slate-700">{routingText(alert.routing)}{alert.yardId ? ` · ${alert.yardId}` : ''}</div>
          <div>{alert.escalatedAt ? `escalated ${ageText(alert.escalatedAt, nowMs)}` : `opened ${ageText(alert.openedAt, nowMs)}`}</div>
          <div>at {alert.triggerDetectorId}</div>
        </div>
      </button>
    </li>
  )
}
