import { until } from '@/lib/format'
import type { OpsOverview } from '@/types'

/** In-flight per endpoint across all customers: the isolation story from the operator's side. */
export function OpsEndpointsTable({ endpoints }: { endpoints: OpsOverview['endpoints'] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full" aria-label="Endpoints in flight">
        <thead className="border-b border-slate-200 bg-slate-50">
          <tr>
            <th className="th">Org</th>
            <th className="th">Endpoint</th>
            <th className="th">Status</th>
            <th className="th">In flight</th>
            <th className="th">Slots held / limit</th>
            <th className="th">Queued</th>
            <th className="th">Waiting in DB</th>
            <th className="th">Failures in a row</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {endpoints.map((e) => {
            const saturated = (e.slotsHeld ?? 0) >= e.effectiveConcurrency && e.effectiveConcurrency > 0
            return (
              <tr key={e.id}>
                <td className="td text-xs">{e.org}</td>
                <td className="td">
                  <div className="text-sm">{e.description}</div>
                  <div className="font-mono text-[11px] text-slate-500">{e.id}</div>
                </td>
                <td className="td text-xs">
                  {e.status === 'disabled' ? <span className="text-red-700">disabled</span> : e.pausedUntil ? <span className="text-amber-700">paused {until(e.pausedUntil)}</span> : e.consecutiveFailures >= 5 ? <span className="text-amber-700">probing</span> : <span className="text-emerald-700">active</span>}
                </td>
                <td className="td num">{e.inFlight}</td>
                <td className="td num">
                  <span className={saturated ? 'font-semibold text-amber-700' : ''}>{e.slotsHeld ?? '—'}</span>
                  <span className="text-slate-400"> / {e.effectiveConcurrency}</span>
                  {saturated && <span className="ml-1 text-[11px] text-amber-700">at limit</span>}
                </td>
                <td className="td num">{e.queued}</td>
                <td className="td num">{e.scheduled}</td>
                <td className="td num">{e.consecutiveFailures}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
