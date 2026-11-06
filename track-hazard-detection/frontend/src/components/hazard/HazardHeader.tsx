import { DetectionBadge, LateBadge, SeverityBadge, StatusBadge } from '@/components/shared/Badges'
import { dateTimeText, KIND_LABEL, mpText } from '@/lib/format'
import type { Hazard } from '@/types'

export function HazardHeader({ hazard: h }: { hazard: Hazard }) {
  return (
    <div className="card flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold text-slate-900">
            {h.code} · {KIND_LABEL[h.kind]}
          </h1>
          <SeverityBadge severity={h.severity} />
          <DetectionBadge status={h.detectionStatus} />
          <StatusBadge status={h.responseStatus} />
          <LateBadge late={h.late} />
        </div>
        <p className="mt-0.5 text-sm text-slate-500">
          {mpText(h.mpFrom, h.mpTo)} · {h.subdivisionId} · segment {h.segmentId} (partition key) · detected {dateTimeText(h.detectedAt)}
        </p>
      </div>
      <div className="ml-auto flex gap-6 text-sm">
        <Metric label="Confidence" value={h.heat ? '—' : h.confidence.toFixed(2)} />
        <Metric label="Peak severity" value={h.peakSeverity} />
        {h.heat && <Metric label="Rail temp" value={`${h.heat.railTempF}°F → ${h.heat.projectedTempF}°F`} />}
        {h.heat && <Metric label="Neutral (RNT)" value={`${h.heat.neutralTempF}°F`} />}
        <Metric label="Stream version" value={`v${h.version}`} />
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="panel-title">{label}</div>
      <div className="font-semibold text-slate-900">{value}</div>
    </div>
  )
}
