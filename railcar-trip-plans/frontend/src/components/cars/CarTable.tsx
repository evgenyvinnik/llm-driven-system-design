import { Link } from '@tanstack/react-router'
import { PlanBadge, PositionBadge, StatusBadge, EtaConfidenceText } from '@/components/shared/Badges'
import { EtaRange } from '@/components/shared/EtaRange'
import { AlertIcon } from '@/components/icons'
import { fmtHours, fmtShort, hoursBetween, relative } from '@/lib/format'
import type { CarRow } from '@/types'

function where(c: CarRow): string {
  if (c.status === 'in_transit' && c.train_run_id) return `on ${c.train_run_id}`
  if (c.status === 'off_network') return `${c.foreign_road ?? 'foreign road'} (after interchange)`
  if (c.status === 'delivered') return `placed at ${c.location_id}`
  return c.location_id ?? '—'
}

export function CarTable({ cars, now, showShipper }: { cars: CarRow[]; now: string; showShipper: boolean }) {
  return (
    <table className="w-full" aria-label="Cars">
      <thead className="border-b border-slate-200 bg-slate-50">
        <tr>
          <th className="th">Car</th>
          {showShipper && <th className="th">Shipper</th>}
          <th className="th">Where</th>
          <th className="th">Trip plan</th>
          <th className="th w-[300px]">ETA at destination (80% range)</th>
          <th className="th">vs original plan</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {cars.map((c) => {
          const drift = c.p50 && c.original_arrival && !c.final ? hoursBetween(c.p50, c.original_arrival) : null
          return (
            <tr key={c.car_id} className="hover:bg-slate-50">
              <td className="td">
                <Link to="/cars/$carId" params={{ carId: c.car_id }} search={{ tab: 'plan' }} className="font-mono text-sm font-semibold text-accent-700 hover:underline">
                  {c.car_id}
                </Link>
                <div className="text-xs text-slate-500">
                  {c.origin_yard} → {c.destination_yard}
                  {c.handoff_road ? ` → ${c.handoff_road}` : ''}
                </div>
              </td>
              {showShipper && <td className="td text-xs">{c.shipper_name}</td>}
              <td className="td">
                <div className="flex flex-wrap items-center gap-1">
                  <StatusBadge status={c.status} />
                  {c.status !== 'delivered' && <PositionBadge confidence={c.position_confidence} />}
                </div>
                <div className="mt-0.5 text-xs text-slate-600">{where(c)}</div>
                <div className="text-[11px] text-slate-400">last read {relative(c.last_observed_at, now)}</div>
              </td>
              <td className="td">
                <PlanBadge status={c.plan_status} version={c.plan_version} />
                {c.open_exceptions > 0 && (
                  <div className="mt-1 flex items-center gap-1 text-xs text-red-700">
                    <AlertIcon className="h-3.5 w-3.5" /> {c.open_exceptions} open exception{c.open_exceptions > 1 ? 's' : ''}
                  </div>
                )}
              </td>
              <td className="td">
                {c.final && c.p50 ? (
                  <span className="text-sm text-emerald-700">Delivered {fmtShort(c.p50)}</span>
                ) : c.p10 && c.p50 && c.p90 ? (
                  <div>
                    <EtaRange p10={c.p10} p50={c.p50} p90={c.p90} now={now} planned={c.original_arrival} />
                    {c.confidence && <EtaConfidenceText confidence={c.confidence} />}
                  </div>
                ) : (
                  <span className="text-xs text-slate-400">no ETA yet</span>
                )}
              </td>
              <td className="td">
                {drift === null ? (
                  <span className="text-xs text-slate-400">—</span>
                ) : (
                  <span className={`text-sm font-medium ${drift > 6 ? 'text-red-700' : drift > 2 ? 'text-amber-700' : 'text-slate-600'}`}>{fmtHours(drift)}</span>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
