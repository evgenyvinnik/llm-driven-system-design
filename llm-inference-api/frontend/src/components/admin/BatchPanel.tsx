import { pct } from '@/lib/format'
import type { Overview } from '@/types'

const TRIGGER_TONE: Record<string, string> = { full: 'bg-emerald-500', max_wait: 'bg-amber-400', deadline: 'bg-red-500' }

/** How full dispatched batches are, and why each one left (full, max wait, deadline). */
export function BatchPanel({ batches, maxSize }: { batches: Overview['batches']; maxSize: number }) {
  const recent = [...batches.recent].reverse()
  return (
    <section className="card p-4" aria-label="Batch fill">
      <div className="flex items-baseline justify-between">
        <h2 className="panel-title">Batch fill</h2>
        <span className="text-xs text-slate-500">batch size {maxSize} · last {recent.length} batches, oldest left</span>
      </div>
      <div className="mt-3 flex h-20 items-end gap-0.5" role="img" aria-label="Recent batch sizes">
        {recent.map((b) => (
          <div
            key={b.id}
            title={`${b.priorityClass} · ${b.size}/${b.maxSize} · ${b.trigger} · waited ${b.oldestWaitMs} ms`}
            className={`min-w-[4px] flex-1 rounded-t-sm ${TRIGGER_TONE[b.trigger] ?? 'bg-slate-400'} ${b.priorityClass === 'batch' ? 'opacity-60' : ''}`}
            style={{ height: `${Math.max(6, (b.size / b.maxSize) * 100)}%` }}
          />
        ))}
      </div>
      <div className="mt-2 flex gap-4 text-xs text-slate-600">
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-emerald-500" />left full</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-amber-400" />left on max wait</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-red-500" />left for a deadline</span>
        <span className="text-slate-400">faded = bulk lane</span>
      </div>
      <table className="mt-3 min-w-full text-xs" aria-label="Batch summary">
        <thead>
          <tr className="text-left text-slate-500">
            <th className="py-1 font-semibold">Lane</th>
            <th className="py-1 font-semibold">Trigger</th>
            <th className="py-1 text-right font-semibold">Batches (10 min)</th>
            <th className="py-1 text-right font-semibold">Avg size</th>
            <th className="py-1 text-right font-semibold">Avg fill</th>
            <th className="py-1 text-right font-semibold">Avg oldest wait</th>
          </tr>
        </thead>
        <tbody className="num">
          {batches.summary.map((s) => (
            <tr key={`${s.priorityClass}-${s.trigger}`} className="border-t border-slate-100">
              <td className="py-1 capitalize">{s.priorityClass === 'batch' ? 'bulk' : s.priorityClass}</td>
              <td className="py-1">{s.trigger.replace('_', ' ')}</td>
              <td className="py-1 text-right">{s.count}</td>
              <td className="py-1 text-right">{s.avgSize}</td>
              <td className="py-1 text-right font-medium">{pct(s.avgFill)}</td>
              <td className="py-1 text-right">{s.avgOldestWaitMs} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
