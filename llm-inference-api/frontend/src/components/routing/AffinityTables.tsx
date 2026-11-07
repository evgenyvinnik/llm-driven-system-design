import { ms } from '@/lib/format'
import type { RoutingView } from '@/types'

export function AffinityTables({ view }: { view: RoutingView }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="card p-4" aria-label="Observed affinity">
        <h2 className="panel-title">Observed routing (last 15 min)</h2>
        <table className="mt-3 min-w-full text-xs">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="py-1 font-semibold">Decision</th>
              <th className="py-1 text-right font-semibold">Requests</th>
              <th className="py-1 text-right font-semibold">Cache hits</th>
              <th className="py-1 text-right font-semibold">First token, hit</th>
              <th className="py-1 text-right font-semibold">First token, miss</th>
            </tr>
          </thead>
          <tbody className="num">
            {view.observed.map((o) => (
              <tr key={o.affinity} className="border-t border-slate-100">
                <td className="py-1">{o.affinity === 'primary' ? 'prefix owner' : o.affinity === 'spill' ? 'spilled (load, drain, down)' : o.affinity}</td>
                <td className="py-1 text-right">{o.count}</td>
                <td className="py-1 text-right">{o.cacheHits}</td>
                <td className="py-1 text-right text-emerald-800">{ms(o.ttftHitMs)}</td>
                <td className="py-1 text-right text-red-800">{ms(o.ttftMissMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-slate-500">
          Bounded load: a backend takes at most ceil(average × {1 + view.epsilon}) requests, relaxed below {view.lowLoadFraction * 100}% of its slots. {view.virtualNodes} virtual nodes per backend.
        </p>
      </section>
      <section className="card p-4" aria-label="Hot prefixes">
        <h2 className="panel-title">Busiest prefixes (last 15 min)</h2>
        <table className="mt-3 min-w-full text-xs">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="py-1 font-semibold">Prefix key</th>
              <th className="py-1 text-right font-semibold">Requests</th>
              <th className="py-1 pl-4 font-semibold">Ring owner</th>
              <th className="py-1 font-semibold">Mostly on</th>
              <th className="py-1 text-right font-semibold">Backends used</th>
              <th className="py-1 text-right font-semibold">Avg first token</th>
            </tr>
          </thead>
          <tbody className="num">
            {view.prefixes.map((p) => (
              <tr key={p.prefixKey} className="border-t border-slate-100">
                <td className="py-1 font-mono">{p.prefixKey.slice(0, 10)}</td>
                <td className="py-1 text-right">{p.requests}</td>
                <td className="py-1 pl-4">{p.owner}</td>
                <td className={`py-1 ${p.mainBackend === p.owner ? '' : 'text-amber-800'}`}>{p.mainBackend}</td>
                <td className="py-1 text-right">{p.backends}</td>
                <td className="py-1 text-right">{ms(p.avgTtftMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}
