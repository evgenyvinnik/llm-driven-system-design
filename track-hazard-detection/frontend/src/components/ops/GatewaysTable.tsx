import { secondsText } from '@/lib/format'
import type { OpsOverview } from '@/types'

/** Per-gateway store-and-forward health: heartbeat, watermark lag, buffered events, duplicates absorbed. */
export function GatewaysTable({ gateways }: { gateways: OpsOverview['gateways'] }) {
  return (
    <table className="min-w-full" aria-label="Gateways">
      <thead className="bg-slate-50">
        <tr>
          <th className="th">Gateway</th>
          <th className="th">Segment</th>
          <th className="th">Last heard</th>
          <th className="th">Watermark lag</th>
          <th className="th">Buffered</th>
          <th className="th">Last seq</th>
          <th className="th">Accepted</th>
          <th className="th">Duplicates</th>
          <th className="th">Coverage</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {gateways.map((g) => (
          <tr key={g.gatewayId} className={g.coverage === 'degraded' ? 'bg-red-50/60' : ''}>
            <td className="td font-mono text-xs">{g.gatewayId}</td>
            <td className="td">{g.segmentId}</td>
            <td className="td">{g.silentSeconds === null ? 'never' : `${secondsText(g.silentSeconds)} ago`}</td>
            <td className="td">{secondsText(g.watermarkLagSeconds)}</td>
            <td className="td">{g.bufferedCount}</td>
            <td className="td">{g.lastSeq}</td>
            <td className="td">{g.eventsAccepted.toLocaleString()}</td>
            <td className="td">{g.duplicates > 0 ? <span className="chip bg-amber-100 text-amber-800">{g.duplicates}</span> : 0}</td>
            <td className="td">{g.coverage === 'degraded' ? <span className="font-semibold text-red-700">silent</span> : 'ok'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
