import { TruckIcon } from '@/components/icons'
import { CommitmentChip, OrderStatus } from '@/components/shared/Chips'
import { gal, money, relHours, simTime } from '@/lib/format'
import type { PlanStop } from '@/types'

export function StopsTable({ stops, nowMs }: { stops: PlanStop[]; nowMs: number }) {
  if (stops.length === 0) return <div className="card p-4 text-sm text-slate-600">No fuel stop needed before the destination: every unit stays above reserve with margin.</div>
  return (
    <div className="card overflow-hidden">
      <table className="w-full" aria-label="Recommended fuel stops">
        <thead className="bg-slate-50">
          <tr>
            <th className="th">Stop</th>
            <th className="th">Arrive</th>
            <th className="th">Fill each unit to</th>
            <th className="th text-right">Gallons</th>
            <th className="th text-right">Cost</th>
            <th className="th">Dwell</th>
            <th className="th">Reservation / truck</th>
          </tr>
        </thead>
        <tbody>
          {stops.map((s) => (
            <tr key={s.seq} className="border-t border-slate-100" data-stop={s.optionId}>
              <td className="td">
                <div className="flex items-center gap-1 font-medium text-slate-900">
                  {s.kind === 'dtl' && <TruckIcon className="h-3.5 w-3.5 text-slate-500" />}
                  {s.name}
                </div>
                <div className="text-xs text-slate-500">
                  {s.kind === 'dtl' ? 'DTL truck' : 'Fuel pad'} · ${s.pricePerGal.toFixed(2)}/gal · MP {Math.round(s.milepost)}
                </div>
              </td>
              <td className="td num">
                <div>{simTime(s.etaMs)}</div>
                <div className="text-xs text-slate-500">{relHours(s.etaMs, nowMs)}</div>
              </td>
              <td className="td">
                <div className="grid grid-cols-2 gap-x-3 text-xs">
                  {s.perUnit.map((u) => (
                    <div key={u.locomotiveId} className="num">
                      <span className="font-mono text-slate-700">{u.locomotiveId}</span>{' '}
                      {u.gallons < 1 ? <span className="text-slate-400">no fuel needed</span> : `${Math.round(u.arrivalGal)} → ${Math.round(u.targetGal)}`}
                    </div>
                  ))}
                </div>
              </td>
              <td className="td num text-right">{gal(s.gallons)}</td>
              <td className="td num text-right">
                <div>{money(s.fuelCost)}</div>
                {s.fee > 0 && <div className="text-xs text-slate-500">+ {money(s.fee)} truck fee</div>}
              </td>
              <td className="td num text-xs">
                <div>{Math.round(s.dwellMinutes)} min</div>
                {s.queueMinutes > 0 && <div className="text-amber-700">incl. ~{Math.round(s.queueMinutes)} min queue</div>}
              </td>
              <td className="td">
                <div className="flex flex-col items-start gap-1">
                  <CommitmentChip state={s.commitment} />
                  {s.commitment === 'accepted' && s.expiresAt && <span className="text-[11px] text-slate-500">held until {simTime(s.expiresAt)}</span>}
                  {s.kind === 'dtl' && (s.orderStatus ? <OrderStatus status={s.orderStatus} /> : <span className="text-[11px] text-slate-500">Truck ordered once accepted and within 12 h</span>)}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
