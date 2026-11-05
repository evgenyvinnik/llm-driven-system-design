import { LateBadge } from '@/components/shared/Badges'
import { DetectorStatusBadge } from '@/components/shared/Badges'
import { timeText } from '@/lib/format'
import type { TripPass } from '@/types'

export function PassTable({ passes }: { passes: TripPass[] }) {
  return (
    <table className="w-full">
      <thead className="border-b border-slate-100">
        <tr>
          <th className="th">Detector</th>
          <th className="th">Passed</th>
          <th className="th">Arrived</th>
          <th className="th">Ambient</th>
          <th className="th">Identity</th>
          <th className="th">Site</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-50">
        {passes.map((p) => (
          <tr key={`${p.detectorId}${p.passId}`}>
            <td className="td"><span className="font-mono">{p.detectorId}</span> <span className="text-xs text-slate-500">MP {p.milepost} {p.name}</span></td>
            <td className="td">{timeText(p.passedAt)}</td>
            <td className="td">{p.late ? <LateBadge lagSeconds={p.lagSeconds} /> : <span className="text-xs text-slate-500">on time</span>}</td>
            <td className="td">{p.ambientF}°F</td>
            <td className="td text-xs">
              {p.identityStatus}{p.hasAei && <span className="chip ml-1 bg-sky-50 text-sky-800 ring-1 ring-sky-200">AEI</span>}
              {p.edgeAlarms.length > 0 && <span className="chip ml-1 bg-red-50 text-red-800 ring-1 ring-red-200">detector alarm</span>}
            </td>
            <td className="td"><DetectorStatusBadge status={p.detectorStatus} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
