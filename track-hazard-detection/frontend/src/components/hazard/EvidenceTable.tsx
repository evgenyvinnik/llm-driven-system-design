import { LaneBadge, LateBadge } from '@/components/shared/Badges'
import { humanize, msText, timeText } from '@/lib/format'
import type { Evidence } from '@/types'

function statusOf(e: Evidence, hazardId: string): string {
  if (e.explainedByTrain) return `explained by ${e.explainedByTrain.replace(/-\d+$/, '')}`
  if (e.hazardId === hazardId) return 'joined'
  if (e.hazardId) return 'other hazard'
  return e.expired ? 'window closed, no hazard' : 'candidate'
}

export function EvidenceTable({ rows, hazardId }: { rows: Evidence[]; hazardId: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full" aria-label="Correlation evidence">
        <thead className="bg-slate-50">
          <tr>
            <th className="th">Sensor</th>
            <th className="th">Evidence</th>
            <th className="th">MP</th>
            <th className="th">Occurred</th>
            <th className="th">Edge → cloud</th>
            <th className="th">Lane</th>
            <th className="th">Schema</th>
            <th className="th">Conf.</th>
            <th className="th">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((e) => (
            <tr key={e.eventId} className={e.hazardId === hazardId && !e.explainedByTrain ? '' : 'text-slate-400'}>
              <td className="td font-mono text-xs">{e.sensorId}</td>
              <td className="td">
                {humanize(e.kind)}
                {typeof e.details.detectionClass === 'string' && <span className="text-slate-500"> ({e.details.detectionClass})</span>}
                {typeof e.details.peakMmS === 'number' && <span className="text-slate-500"> ({e.details.peakMmS} mm/s)</span>}
                {typeof e.details.wire === 'number' && <span className="text-slate-500"> (wire {e.details.wire})</span>}
              </td>
              <td className="td">{e.milepost.toFixed(1)}</td>
              <td className="td">{timeText(e.occurredAt)}</td>
              <td className="td">
                {e.ingestedAt ? msText(Date.parse(e.ingestedAt) - Date.parse(e.occurredAt)) : '—'} <LateBadge late={e.late} />
              </td>
              <td className="td">
                <LaneBadge lane={e.lane} />
              </td>
              <td className="td text-xs">{e.schemaVersion ? `v${e.schemaVersion}${e.schemaVersion === 1 && e.kind === 'camera_obstruction' ? ' → v2' : ''}` : '—'}</td>
              <td className="td">{e.confidence.toFixed(2)}</td>
              <td className="td text-xs">{statusOf(e, hazardId)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
