import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { HoldBadge, LateBadge } from '@/components/shared/Badges'
import { TierBadge } from '@/components/shared/TierBadge'
import { ageText, humanize, kindText, positionText, timeText } from '@/lib/format'
import { api } from '@/services/api'
import type { WorkOrder } from '@/types'
import { FindingForm } from './FindingForm'

interface Props {
  workOrder: WorkOrder
  nowMs: number
  onChanged: (message?: string) => void
}

export function WorkOrderCard({ workOrder: w, nowMs, onChanged }: Props) {
  const [open, setOpen] = useState(false)
  const done = w.status === 'completed' || w.status === 'cancelled'
  const arrival = w.tripStatus === 'arrived' ? `Train arrived ${ageText(w.arrivedAt, nowMs)}` : w.nextYardEta ? `Train ETA ${timeText(w.nextYardEta)}` : 'Train en route'
  return (
    <li className="card p-4" data-work-order={w.id}>
      <div className="flex flex-wrap items-center gap-2">
        {w.kind === 'audit' ? <span className="chip bg-sky-50 font-semibold text-sky-800 ring-1 ring-sky-200">AUDIT</span> : <TierBadge tier={w.priority} />}
        <Link to="/cars/$carId" params={{ carId: w.carId }} search={{ position: w.kind === 'hot_bearing' ? w.position : undefined }} className="font-mono text-base font-semibold text-slate-900 hover:underline">{w.carId}</Link>
        <span className="text-sm text-slate-600">{w.kind === 'audit' ? 'random audit, whole car' : `${kindText(w.kind)}${w.kind === 'hot_bearing' ? ` · ${positionText(w.kind, w.position)}` : ''}`}</span>
        <span className="text-sm text-slate-400">·</span>
        <span className="font-mono text-sm text-slate-600">{w.symbol}</span>
        {w.late && <LateBadge lagSeconds={w.dataLagSeconds} />}
        <HoldBadge status={w.holdStatus} />
        <span className="flex-1" />
        <span className="text-xs text-slate-500">{done ? `${humanize(w.status)} ${ageText(w.completedAt, nowMs)}` : arrival}</span>
      </div>
      <p className="mt-2 text-sm text-slate-700">{w.reasons[0]}</p>
      {w.routeNote && <p className="mt-1 text-xs text-slate-500">{w.routeNote}</p>}
      {done ? (
        <p className="mt-2 text-sm">
          <span className="font-medium">{humanize(w.finding ?? w.status)}</span>
          {w.disposition && <span className="text-slate-600"> · {humanize(w.disposition)}</span>}
          {w.recordedBy && <span className="text-slate-500"> · by {w.recordedBy}</span>}
          {w.findingNotes && <span className="block text-xs text-slate-500">{w.findingNotes}</span>}
        </p>
      ) : (
        <div className="mt-3 flex gap-2">
          {w.status === 'open' && (
            <button type="button" className="btn-secondary" onClick={() => void api.startWorkOrder(w.id).then(() => onChanged()).catch(() => onChanged())}>
              Start inspection
            </button>
          )}
          {w.status === 'in_progress' && <span className="chip bg-sky-50 text-sky-800 ring-1 ring-sky-200">in progress · {w.assignedTo}</span>}
          <button type="button" className={open ? 'btn-ghost' : 'btn-primary'} onClick={() => setOpen((o) => !o)}>{open ? 'Cancel' : 'Record finding'}</button>
        </div>
      )}
      {open && !done && (
        <FindingForm workOrder={w} onDone={(result) => { setOpen(false); onChanged(result === 'queued' ? `Offline: finding for ${w.carId} saved on this device and will sync.` : undefined) }} />
      )}
    </li>
  )
}
