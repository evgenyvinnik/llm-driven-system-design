import { msText } from '@/lib/format'
import type { Latency } from '@/types'

/** Cloud-side time (ingest → correlator decision) per lane: the priority lane keeps critical events fast while bulk backs up. */
export function LaneCompare({ decisions }: { decisions: Latency['decisions'] }) {
  const lanes: Array<[keyof Latency['decisions'], string]> = [
    ['critical', 'Critical lane'],
    ['bulk', 'Bulk lane'],
  ]
  const max = Math.max(1, ...lanes.map(([k]) => decisions[k].cloud.p99 ?? 0))
  return (
    <table className="min-w-full text-sm" aria-label="Lane latency">
      <thead>
        <tr>
          <th className="th pl-0">Lane</th>
          <th className="th">Samples</th>
          <th className="th">Cloud p50</th>
          <th className="th">Cloud p99</th>
          <th className="th w-1/3">p99</th>
          <th className="th">Late events</th>
        </tr>
      </thead>
      <tbody>
        {lanes.map(([k, label]) => {
          const d = decisions[k]
          return (
            <tr key={k}>
              <td className="td pl-0 font-medium">{label}</td>
              <td className="td">{d.cloud.count}</td>
              <td className="td">{msText(d.cloud.p50)}</td>
              <td className="td">{msText(d.cloud.p99)}</td>
              <td className="td">
                <div className="h-2.5 rounded bg-slate-100">
                  <div className={`h-2.5 rounded ${k === 'critical' ? 'bg-red-500' : k === 'bulk' ? 'bg-slate-400' : 'bg-sky-500'}`} style={{ width: `${((d.cloud.p99 ?? 0) / max) * 100}%` }} />
                </div>
              </td>
              <td className="td">{d.late}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
