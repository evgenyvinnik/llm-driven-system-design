import { Link } from '@tanstack/react-router'
import { AlertIcon, TruckIcon } from '@/components/icons'
import { Chip, ConfidenceChip, LifecycleChip, OrderStatus } from '@/components/shared/Chips'
import { FuelBar } from '@/components/shared/FuelBar'
import { ageLabel, gal, relHours } from '@/lib/format'
import type { TrainSummary } from '@/types'

export function TrainRow({ train, nowMs }: { train: TrainSummary; nowMs: number }) {
  const next = train.plan?.nextStop
  const age = ageLabel(train.lastSeenMs, nowMs)
  return (
    <tr className="border-t border-slate-100 hover:bg-slate-50" data-train={train.id}>
      <td className="td">
        <Link to="/trains/$trainId" params={{ trainId: train.id }} className="font-semibold text-accent-700 hover:underline">
          {train.symbol}
        </Link>
        <div className="text-xs text-slate-500">
          {train.origin} → {train.destination}
        </div>
        <div className="num text-xs text-slate-400">
          {train.plannedTons.toLocaleString()} t · {train.units.length} units
        </div>
      </td>
      <td className="td w-56">
        <div className="h-1.5 rounded-full bg-slate-100">
          <div className="h-1.5 rounded-full bg-slate-500" style={{ width: `${train.progressPct}%` }} />
        </div>
        <div className="num mt-1 text-xs text-slate-600">
          MP {Math.round(train.milepost)} / {train.totalMiles} · {Math.round(train.speedMph)} mph
        </div>
        <div className="text-xs text-slate-500">
          {train.status === 'arrived' ? 'Arrived' : train.nextLocation ? `Next: ${train.nextLocation.name}` : '—'}
          {age !== 'live' && <span className="ml-1 font-medium text-amber-700">· data {age}</span>}
        </div>
      </td>
      <td className="td">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          {train.units.map((u) => (
            <FuelBar key={u.locomotiveId} unit={u} compact />
          ))}
        </div>
      </td>
      <td className="td">
        {next ? (
          <div>
            <div className="flex items-center gap-1 font-medium text-slate-800">
              {next.kind === 'dtl' && <TruckIcon className="h-3.5 w-3.5 text-slate-500" />}
              {next.name} <span className="text-xs font-normal text-slate-500">{next.kind === 'dtl' ? 'DTL truck' : 'pad'}</span>
            </div>
            <div className="num text-xs text-slate-500">
              {relHours(next.etaMs, nowMs)} · {gal(next.gallons)}
            </div>
            {next.orderStatus && (
              <div className="mt-0.5">
                <OrderStatus status={next.orderStatus} />
              </div>
            )}
          </div>
        ) : (
          <span className="text-xs text-slate-500">{train.plan ? 'No stop needed' : 'Planning…'}</span>
        )}
      </td>
      <td className="td">
        {train.plan && (
          <div className="flex flex-col items-start gap-1">
            <span className="text-xs text-slate-500">v{train.plan.version}</span>
            <LifecycleChip lifecycle={train.plan.lifecycle} />
            {train.plan.confidence !== 'high' && <ConfidenceChip confidence={train.plan.confidence} />}
            {train.plan.proposalVersion && <Chip kind="warn">Change awaiting confirmation</Chip>}
          </div>
        )}
      </td>
      <td className="td">
        {train.alerts.critical + train.alerts.warning > 0 ? (
          <span className={`inline-flex items-center gap-1 text-xs font-semibold ${train.alerts.critical ? 'text-red-700' : 'text-amber-700'}`}>
            <AlertIcon className="h-3.5 w-3.5" />
            {train.alerts.critical ? `${train.alerts.critical} critical` : ''} {train.alerts.warning ? `${train.alerts.warning} warning` : ''}
          </span>
        ) : (
          <span className="text-xs text-slate-400">None</span>
        )}
      </td>
    </tr>
  )
}
