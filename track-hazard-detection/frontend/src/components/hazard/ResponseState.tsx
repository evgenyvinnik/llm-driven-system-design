import { countdown, timeText } from '@/lib/format'
import type { Hazard, WarnedTrain } from '@/types'

const LEVELS = ['desk dispatcher', 'chief dispatcher', 'manager of operations']

/** What the process manager and the people have done so far. */
export function ResponseState({ hazard: h, approaching, now }: { hazard: Hazard; approaching: WarnedTrain[]; now: number }) {
  const a = h.alert
  const due = a && !a.acknowledgedAt && h.open ? countdown(a.ackDeadlineAt, now) : null
  const warnedIds = new Set(h.warnedTrains.filter((t) => !t.releasedAt).map((t) => t.trainId))
  const unwarned = approaching.filter((t) => !warnedIds.has(t.trainId))
  return (
    <div className="space-y-3 text-sm">
      <Row label="Alert">
        {a ? (
          <>
            {a.alertId} · {a.severity} · to <b>{a.assignee ?? `${a.deskId} desk`}</b> ({a.deskId} desk) at {timeText(a.issuedAt)}
            {a.escalationLevel > 0 && <span className="ml-1 chip bg-red-100 text-red-800">escalated L{a.escalationLevel}: {a.escalationTarget ?? LEVELS[a.escalationLevel]}</span>}
            <div className={due?.overdue ? 'font-semibold text-red-600' : 'text-slate-500'}>
              {a.acknowledgedAt ? `Acknowledged by ${a.acknowledgedBy} at ${timeText(a.acknowledgedAt)}` : due ? `Acknowledgment ${due.text}` : 'Not acknowledged'}
            </div>
          </>
        ) : (
          <span className="text-slate-500">Not issued (severity below MEDIUM)</span>
        )}
      </Row>
      <Row label="Trains warned">
        {h.warnedTrains.length === 0 ? (
          <span className="text-slate-500">None</span>
        ) : (
          <ol className="space-y-0.5">
            {h.warnedTrains.map((t, i) => (
              <li key={`${t.trainId}-${i}`} className={t.releasedAt ? 'text-slate-400 line-through' : ''}>
                {i + 1}. <b>{t.symbol}</b> ETA {t.etaMinutes} min, {t.distanceMiles} mi · {t.automatic ? 'automatic' : 'by dispatcher'} {timeText(t.warnedAt)}
                {t.releasedAt && ` · released ${timeText(t.releasedAt)}`}
              </li>
            ))}
          </ol>
        )}
        {h.open && unwarned.length > 0 && <div className="mt-1 text-xs text-amber-700">Approaching, not warned: {unwarned.map((t) => `${t.symbol} (ETA ${t.etaMinutes} min)`).join(', ')}</div>}
      </Row>
      <Row label="Slow orders">
        {h.restrictions.length === 0 ? (
          <span className="text-slate-500">None</span>
        ) : (
          <ul className="space-y-0.5">
            {h.restrictions.map((r) => (
              <li key={r.restrictionId} className={r.liftedAt ? 'text-slate-400' : ''}>
                <b>{r.maxSpeedMph} mph</b> MP {r.mpFrom}–{r.mpTo} · {r.automatic ? 'standing order (automatic)' : r.issuedBy} · {r.liftedAt ? `lifted ${timeText(r.liftedAt)} by ${r.liftedBy}` : 'active'}
              </li>
            ))}
          </ul>
        )}
      </Row>
      <Row label="Inspector">{h.inspector ? `${h.inspector.name} dispatched ${timeText(h.inspector.dispatchedAt)}, ETA ${h.inspector.etaMinutes} min` : <span className="text-slate-500">Not dispatched</span>}</Row>
      {!h.open && (
        <Row label="Closed">
          {h.responseStatus === 'false_alarm' ? 'False alarm' : 'Cleared'} by {h.closedBy} at {timeText(h.closedAt)}
          {h.closeNote && <div className="text-slate-500">“{h.closeNote}”</div>}
        </Row>
      )}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2">
      <div className="panel-title pt-0.5">{label}</div>
      <div className="text-slate-700">{children}</div>
    </div>
  )
}
