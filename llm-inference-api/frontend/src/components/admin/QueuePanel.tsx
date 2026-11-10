import { Meter } from '@/components/shared/StatTile'
import { ms } from '@/lib/format'
import type { Overview } from '@/types'

export function QueuePanel({ queues, open }: { queues: Overview['queues']; open: Overview['open'] }) {
  return (
    <section className="card p-4" aria-label="Queues">
      <h2 className="panel-title">Queue depth per priority class</h2>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        {queues.map((q) => {
          const running = open.find((o) => o.priorityClass === q.class && o.status === 'running')?.count ?? 0
          const full = q.depth >= q.limit
          return (
            <div key={q.class} className="space-y-2" data-testid={`queue-${q.class}`}>
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-semibold capitalize text-slate-800">{q.class === 'batch' ? 'Bulk' : 'Interactive'}</span>
                <span className="num text-sm text-slate-600">
                  <span className={`text-lg font-semibold ${full ? 'text-red-700' : 'text-slate-900'}`}>{q.depth}</span> / {q.limit} queued
                </span>
              </div>
              <Meter value={q.depth} max={q.limit} tone={full ? 'bg-red-500' : q.depth / q.limit > 0.7 ? 'bg-amber-500' : 'bg-accent-500'} label={`${q.class} queue depth`} />
              <p className="text-xs text-slate-500">
                oldest waiting {ms(q.oldestWaitMs)} · {running} generating{full ? ' · full: new requests get 529' : ''}
              </p>
              <ul className="space-y-1">
                {q.tenants.slice(0, 5).map((t) => (
                  <li key={t.orgId} className="flex items-center gap-2 text-xs">
                    <span className="w-28 truncate text-slate-700">{t.orgName}</span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                      <div className="h-full bg-slate-400" style={{ width: `${Math.min(100, (t.depth / Math.max(1, q.depth)) * 100)}%` }} />
                    </div>
                    <span className="num w-8 text-right text-slate-600">{t.depth}</span>
                  </li>
                ))}
                {q.tenants.length === 0 && <li className="text-xs text-slate-400">Empty</li>}
              </ul>
            </div>
          )
        })}
      </div>
    </section>
  )
}
