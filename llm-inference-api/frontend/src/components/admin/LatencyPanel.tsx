import { ms } from '@/lib/format'
import type { Overview } from '@/types'

/** Queue time and model time side by side, so a growing queue is never read as a slow model. */
export function LatencyPanel({ latency }: { latency: Overview['latency'] }) {
  return (
    <section className="card p-4" aria-label="Latency split">
      <h2 className="panel-title">Latency split (completed, last 5 min)</h2>
      <table className="mt-3 min-w-full text-xs">
        <thead>
          <tr className="text-left text-slate-500">
            <th className="py-1 font-semibold">Lane</th>
            <th className="py-1 text-right font-semibold">n</th>
            <th className="py-1 text-right font-semibold">Queue p50 / p95</th>
            <th className="py-1 text-right font-semibold">First token p50 / p95</th>
            <th className="py-1 text-right font-semibold">Total p50</th>
            <th className="py-1 text-right font-semibold">Tokens/s</th>
          </tr>
        </thead>
        <tbody className="num">
          {latency.map((l) => (
            <tr key={l.priorityClass} className="border-t border-slate-100">
              <td className="py-1 capitalize">{l.priorityClass === 'batch' ? 'bulk' : l.priorityClass}</td>
              <td className="py-1 text-right">{l.count}</td>
              <td className="py-1 text-right text-amber-800">{ms(l.queueP50Ms)} / {ms(l.queueP95Ms)}</td>
              <td className="py-1 text-right text-sky-800">{ms(l.ttftP50Ms)} / {ms(l.ttftP95Ms)}</td>
              <td className="py-1 text-right">{ms(l.totalP50Ms)}</td>
              <td className="py-1 text-right">{l.tokensPerSec ?? '–'}</td>
            </tr>
          ))}
          {latency.length === 0 && (
            <tr>
              <td className="py-2 text-slate-400" colSpan={6}>No completed requests in the last 5 minutes.</td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  )
}
