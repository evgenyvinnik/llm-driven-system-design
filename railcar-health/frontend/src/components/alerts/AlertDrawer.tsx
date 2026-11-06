import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { XIcon } from '@/components/icons'
import { HoldBadge, LateBadge } from '@/components/shared/Badges'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { TierBadge } from '@/components/shared/TierBadge'
import { actionText, dateTimeText, kindText, positionText } from '@/lib/format'
import { api } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'
import { useClockStore } from '@/stores/clock-store'
import { useLiveStore } from '@/stores/live-store'
import type { Alert, AlertEvent, AlertNotification } from '@/types'
import { AckForm } from './AckForm'
import { FeatureGrid } from './FeatureGrid'
import { Lifecycle } from './Lifecycle'

/** The owner acknowledges: dispatchers for train-handling alerts, the owning yard for car-inspection ones. */
function canAck(user: { role: string; yardId: string | null } | null, alert: Alert): boolean {
  if (!user) return false
  if (user.role === 'admin') return alert.ownerRole !== 'owner'
  if (user.role === 'dispatcher') return alert.ownerRole === 'dispatcher'
  return user.role === 'yard' && alert.ownerRole === 'yard' && alert.ownerId === user.yardId
}

interface Detail {
  alert: Alert
  events: AlertEvent[]
  notifications: AlertNotification[]
}

export function AlertDrawer({ alertId, onClose }: { alertId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const revision = useLiveStore((s) => s.revisions.alerts)
  const user = useAuthStore((s) => s.user)
  const nowMs = useClockStore((s) => s.now)()

  useEffect(() => {
    let cancelled = false
    api
      .alert(alertId)
      .then((d) => !cancelled && setDetail(d))
      .catch((err) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
  }, [alertId, revision])

  if (error) return <aside className="w-[440px] shrink-0 border-l border-slate-200 bg-white p-4"><ErrorNote message={error} /></aside>
  if (!detail || detail.alert.id !== alertId) return <aside className="w-[440px] shrink-0 border-l border-slate-200 bg-white"><Loading /></aside>
  const { alert, events, notifications } = detail
  return (
    <aside className="flex w-[440px] shrink-0 flex-col overflow-y-auto border-l border-slate-200 bg-white" aria-label="Alert detail">
      <div className="flex items-start justify-between gap-2 border-b border-slate-100 p-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <TierBadge tier={alert.tier} size="lg" />
            {alert.late && <LateBadge lagSeconds={alert.dataLagSeconds} />}
            <HoldBadge status={alert.holdStatus} />
          </div>
          <h2 className="font-mono text-lg font-semibold text-slate-900">{alert.carId} <span className="text-slate-500">{positionText(alert.kind, alert.position)}</span></h2>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{kindText(alert.kind)}</p>
          <p className="text-sm text-slate-600">
            <Link to="/trains/$tripId" params={{ tripId: alert.tripId }} className="font-mono text-accent-700 hover:underline">{alert.symbol} {alert.direction}</Link>
            {' · '}
            <Link to="/cars/$carId" params={{ carId: alert.carId }} search={{ position: alert.kind === 'hot_bearing' ? alert.position : undefined }} className="text-accent-700 hover:underline">car history</Link>
            {' · '}
            <Link to="/timeline" search={{ case: alert.id }} className="text-accent-700 hover:underline">case events</Link>
            {' · owner '}{alert.ownerMark}
          </p>
        </div>
        <button type="button" className="btn-ghost p-1" onClick={onClose} aria-label="Close"><XIcon className="h-4 w-4" /></button>
      </div>
      <div className="space-y-4 p-4">
        {notice && <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">{notice}</p>}
        <Lifecycle alert={alert} nowMs={nowMs} />
        <div className="rounded-md bg-slate-900 px-3 py-2.5 text-sm text-white">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{actionText(alert.action)}</div>
          <div className="mt-0.5">{alert.routeNote}</div>
        </div>
        <section>
          <div className="panel-title mb-1.5">Why</div>
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
            {alert.reasons.map((r) => <li key={r}>{r}</li>)}
          </ul>
        </section>
        <FeatureGrid f={alert.features} />
        {alert.status === 'open' && canAck(user, alert) && (
          <AckForm alert={alert} onDone={(message) => { setNotice(message); useLiveStore.getState().bump(['alerts']) }} />
        )}
        {alert.status === 'acknowledged' && (
          <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            Acknowledged by {alert.acknowledgedBy}: {alert.ackAction?.replace(/_/g, ' ')}{alert.ackNote ? ` — ${alert.ackNote}` : ''}
          </p>
        )}
        <section>
          <div className="mb-1.5 flex items-baseline justify-between"><span className="panel-title">Timeline</span><span className="text-[11px] text-slate-400">from the case's event stream · v{alert.version}</span></div>
          <ol className="space-y-1.5 border-l border-slate-200 pl-3 text-sm">
            {events.map((e, i) => (
              <li key={i}>
                <span className="font-medium capitalize text-slate-800">{e.kind.replace(/_/g, ' ')}</span>
                {e.tier && (e.kind === 'opened' || e.kind === 'escalated') ? <span className="text-slate-500"> at {['', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'][e.tier]}</span> : null}
                {e.detectorId && <span className="text-slate-500"> at {e.detectorId}</span>}
                <span className="text-xs text-slate-400"> · {dateTimeText(e.at)} · {e.actor}</span>
                {e.note && <div className="text-xs text-slate-500">{e.note}</div>}
              </li>
            ))}
          </ol>
        </section>
        <section>
          <div className="panel-title mb-1.5">Notified</div>
          <ul className="space-y-1 text-xs text-slate-600">
            {notifications.map((n, i) => (
              <li key={i}><span className="font-semibold text-slate-800">{n.channel.replace('_', ' ')}</span> → {n.target} <span className="text-slate-400">({n.kind})</span></li>
            ))}
            {notifications.length === 0 && <li>No notifications yet.</li>}
          </ul>
        </section>
      </div>
    </aside>
  )
}
