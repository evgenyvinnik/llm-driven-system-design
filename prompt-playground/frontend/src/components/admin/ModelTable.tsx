import { formatCount, formatMs } from '@/lib/format'
import type { AdminOverview } from '@/types'

/** Queue time and time to first token are separate columns so queueing is never mistaken for a slow model. */
export function ModelTable({ rows }: { rows: AdminOverview['perModel'] }) {
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-slate-100 px-4 py-2.5 panel-title">Models · last 24h</div>
      <table className="w-full text-sm tabular-nums">
        <thead className="bg-slate-50 text-left text-xs text-slate-500">
          <tr>
            <th className="px-4 py-2 font-medium">Model</th>
            <th className="px-4 py-2 text-right font-medium">Runs</th>
            <th className="px-4 py-2 text-right font-medium">Failed</th>
            <th className="px-4 py-2 text-right font-medium">Queue p50</th>
            <th className="px-4 py-2 text-right font-medium">TTFT p50 / p95</th>
            <th className="px-4 py-2 text-right font-medium">Duration p95</th>
            <th className="px-4 py-2 text-right font-medium">Tokens in / out</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 text-slate-700">
          {rows.map((r) => (
            <tr key={r.model}>
              <td className="px-4 py-2 font-mono text-xs text-slate-900">{r.model}</td>
              <td className="px-4 py-2 text-right">{r.runs}</td>
              <td className="px-4 py-2 text-right">
                {r.failed} <span className="text-xs text-slate-400">({r.runs ? Math.round((r.failed / r.runs) * 100) : 0}%)</span>
              </td>
              <td className="px-4 py-2 text-right">{formatMs(r.queueP50Ms)}</td>
              <td className="px-4 py-2 text-right">
                {formatMs(r.ttftP50Ms)} / {formatMs(r.ttftP95Ms)}
              </td>
              <td className="px-4 py-2 text-right">{formatMs(r.durationP95Ms)}</td>
              <td className="px-4 py-2 text-right">
                {formatCount(r.inputTokens)} / {formatCount(r.outputTokens)}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="px-4 py-6 text-center text-xs text-slate-400">
                No runs in the last 24 hours.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
