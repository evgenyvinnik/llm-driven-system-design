import { Link } from '@tanstack/react-router'
import { DetectionBadge, LateBadge, SeverityBadge, StatusBadge } from '@/components/shared/Badges'
import { Empty } from '@/components/shared/Loading'
import { ageText, KIND_LABEL, mpText } from '@/lib/format'
import type { Hazard } from '@/types'

export function HazardList({ hazards, now }: { hazards: Hazard[]; now: number }) {
  const sorted = [...hazards].sort((a, b) => Number(b.open) - Number(a.open) || b.detectedAt.localeCompare(a.detectedAt))
  if (sorted.length === 0) return <Empty>No open hazards. The line is clear.</Empty>
  return (
    <ul className="divide-y divide-slate-100" aria-label="Active hazards">
      {sorted.map((h) => (
        <li key={h.hazardId}>
          <Link to="/hazards/$hazardId" params={{ hazardId: h.hazardId }} className={`flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 ${h.open ? '' : 'opacity-60'}`}>
            <SeverityBadge severity={h.severity} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-900">
                {h.code} · {KIND_LABEL[h.kind]} · {mpText(h.mpFrom, h.mpTo)}
                <LateBadge late={h.late} />
              </div>
              <div className="text-xs text-slate-500">
                {h.subdivisionId} · {h.evidence.length} evidence · conf {h.confidence.toFixed(2)} · detected {ageText(h.detectedAt, now)}
                {h.warnedTrains.some((t) => !t.releasedAt) && ` · ${h.warnedTrains.filter((t) => !t.releasedAt).length} train(s) warned`}
              </div>
            </div>
            <DetectionBadge status={h.detectionStatus} />
            <StatusBadge status={h.responseStatus} />
          </Link>
        </li>
      ))}
    </ul>
  )
}
