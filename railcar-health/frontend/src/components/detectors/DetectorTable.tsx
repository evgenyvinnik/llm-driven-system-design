import { DetectorStatusBadge } from '@/components/shared/Badges'
import { ageText, signed } from '@/lib/format'
import type { Detector } from '@/types'

const COVERAGE: Record<Detector['coverage'], [string, string]> = {
  live: ['Live', 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200'],
  delayed: ['Delayed: buffering at site', 'bg-violet-50 text-violet-800 ring-1 ring-violet-200'],
  catching_up: ['Catching up', 'bg-sky-50 text-sky-800 ring-1 ring-sky-200'],
  gap: ['Gap: no data coming', 'bg-red-50 text-red-800 ring-1 ring-red-200'],
}

function CoverageBadge({ coverage, pending }: { coverage: Detector['coverage']; pending: number }) {
  const [label, style] = COVERAGE[coverage]
  return <span className={`chip ${style}`}>{label}{coverage === 'catching_up' ? ` (${pending} queued)` : ''}</span>
}

export function DetectorTable({ detectors, nowMs, selected, onSelect }: { detectors: Detector[]; nowMs: number; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <table className="w-full" aria-label="Detectors">
      <thead className="border-b border-slate-100 bg-slate-50">
        <tr><th className="th">Detector</th><th className="th">Site</th><th className="th">Status</th><th className="th">Coverage now</th><th className="th">Last heartbeat</th><th className="th">Offset vs neighbours</th><th className="th">Missed trains</th></tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {detectors.map((d) => (
          <tr key={d.id} onClick={() => onSelect(d.id)} className={`cursor-pointer hover:bg-slate-50 ${selected === d.id ? 'bg-accent-50' : ''}`}>
            <td className="td"><span className="font-mono font-semibold">{d.id}</span> <span className="text-xs text-slate-500">{d.name}</span></td>
            <td className="td whitespace-nowrap text-xs">MP {d.milepost} · {d.subdivisionId}{d.hasAei ? ' · AEI' : ''}{d.brakingZone ? ' · braking zone' : ''}</td>
            <td className="td">
              <DetectorStatusBadge status={d.status} />
              {d.statusReason && <div className="mt-0.5 max-w-xs text-xs text-slate-500">{d.statusReason}</div>}
            </td>
            <td className="td text-xs"><CoverageBadge coverage={d.coverage} pending={d.pendingPasses} /><div className="mt-0.5 text-slate-500">last train {ageText(d.lastPassAt, nowMs)}</div></td>
            <td className="td text-xs">{ageText(d.lastHeardAt, nowMs)}{d.bufferedPasses > 0 ? ` · ${d.bufferedPasses} buffered` : ''}</td>
            <td className="td text-xs">{d.biasOffsetF === null ? '—' : `${signed(d.biasOffsetF)}°F (${d.biasSamples} trains)`}</td>
            <td className="td text-xs">{d.missedPasses || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
