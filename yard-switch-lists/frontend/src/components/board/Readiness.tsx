import { ReadinessChip } from '@/components/shared/Chips'
import { clock } from '@/lib/format'
import type { Board, Readiness as Row } from '@/types'

export function ReadinessPanel({ readiness, onHold }: { readiness: Row[]; onHold: (row: Row) => void }) {
  return (
    <section className="card" aria-label="Outbound train readiness">
      <h2 className="panel-title border-b border-slate-200 px-3 py-2">Outbound trains</h2>
      <table className="w-full" aria-label="Outbound trains">
        <thead>
          <tr>
            <th className="th">Train</th>
            <th className="th">Departs</th>
            <th className="th text-right">Cars</th>
            <th className="th text-right">Feet</th>
            <th className="th text-right">Slack</th>
            <th className="th">Status</th>
            <th className="th" />
          </tr>
        </thead>
        <tbody>
          {readiness.map((r) => {
            const revised = r.departure !== r.scheduledDeparture
            return (
              <tr key={r.outboundId} className="border-t border-slate-100">
                <td className="td font-mono text-xs font-semibold">{r.symbol}</td>
                <td className="td num">
                  {clock(r.departure)}
                  {revised && <span className="ml-1 text-xs text-slate-500" title={`Scheduled ${clock(r.scheduledDeparture)}`}>held</span>}
                </td>
                <td className="td num text-right">{r.cars}<span className="text-xs text-slate-400"> /{r.minCars}</span></td>
                <td className="td num text-right">{r.lengthFt.toLocaleString()}</td>
                <td className="td num text-right">{r.slackMin === null ? '–' : `${r.slackMin} min`}</td>
                <td className="td"><ReadinessChip status={r.status} /></td>
                <td className="td text-right">
                  {r.status !== 'departed' && r.status !== 'missed' && (
                    <button type="button" className="text-xs text-accent-700 hover:underline" onClick={() => onHold(r)}>Hold</button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}

export function InboundPanel({ inbound }: { inbound: Board['inbound'] }) {
  return (
    <section className="card" aria-label="Inbound trains">
      <h2 className="panel-title border-b border-slate-200 px-3 py-2">Inbound trains</h2>
      <ul className="divide-y divide-slate-100 text-sm">
        {inbound.map((i) => (
          <li key={i.id} className="flex items-center gap-2 px-3 py-1.5">
            <span className="w-24 font-mono text-xs font-semibold">{i.id} {i.symbol}</span>
            <span className="num text-xs text-slate-600">{i.carCount} cars</span>
            <span className="num ml-auto text-xs text-slate-700">
              {i.actualArrival ? `arrived ${clock(i.actualArrival)} on ${i.receivingTrackId}` : `ETA ${clock(i.eta)}`}
            </span>
            {i.slipMin > 0 && <span className="chip bg-amber-100 text-amber-900">+{i.slipMin} min</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}
