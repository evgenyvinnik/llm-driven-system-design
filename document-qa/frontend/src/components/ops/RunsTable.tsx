import { StatusChip } from '@/components/shared/Chips'
import { Empty } from '@/components/shared/Loading'
import { ago, ms, shortId } from '@/lib/format'
import type { OpsOverview } from '@/types'

export function RunsTable({ runs }: { runs: OpsOverview['runs'] }) {
  return (
    <section className="card" aria-label="Recent answer runs">
      <div className="border-b border-slate-100 px-4 py-2">
        <h2 className="panel-title">Recent answer runs (usage only, no content)</h2>
      </div>
      {runs.length === 0 ? (
        <Empty>No answers yet.</Empty>
      ) : (
        <table className="w-full" aria-label="Runs">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              <th className="th">Run</th>
              <th className="th">Status</th>
              <th className="th">Cache</th>
              <th className="th text-right">Tokens in/out</th>
              <th className="th text-right">Queue</th>
              <th className="th text-right">Retrieval</th>
              <th className="th text-right">TTFT</th>
              <th className="th text-right">Generation</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {runs.map((r) => (
              <tr key={r.id}>
                <td className="td text-xs">
                  <span className="font-mono">{shortId(r.id)}</span> <span className="text-slate-400">{ago(r.createdAt)}</span>
                </td>
                <td className="td">
                  <StatusChip status={r.status} />
                </td>
                <td className="td text-xs">{r.cacheStatus ?? '—'}</td>
                <td className="td num text-right text-xs">
                  {r.inputTokens ?? '—'} / {r.outputTokens ?? '—'}
                </td>
                <td className="td num text-right text-xs">{ms(r.queueMs)}</td>
                <td className="td num text-right text-xs">{ms(r.retrievalMs)}</td>
                <td className="td num text-right text-xs">{ms(r.ttftMs)}</td>
                <td className="td num text-right text-xs">{ms(r.generationMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
