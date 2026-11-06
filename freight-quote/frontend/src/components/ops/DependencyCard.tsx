import { BreakerBadge } from '@/components/shared/Badges'
import { DEPENDENCY_LABEL, ms, pct } from '@/lib/format'
import type { DepOverview, DepServerStats, Dependency, Knobs } from '@/types'

interface Props {
  dep: Dependency
  stats: DepOverview
  server?: DepServerStats
  knobs?: Knobs
  budgetMs: number
  hedged: boolean
}

const Row = ({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) => (
  <div className="flex justify-between text-xs">
    <span className="text-slate-500">{label}</span>
    <span className={`tabular-nums ${warn ? 'font-semibold text-red-700' : 'text-slate-800'}`}>{value}</span>
  </div>
)

export function DependencyCard({ dep, stats: s, server, knobs, budgetMs, hedged }: Props) {
  const failures = s.timeout + s.error + s.deadline
  const versioned = dep === 'pricing' || dep === 'fuel'
  return (
    <section className="card p-4" aria-label={DEPENDENCY_LABEL[dep]}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <div className="font-semibold text-slate-900">{DEPENDENCY_LABEL[dep]}</div>
          <div className="text-xs text-slate-500">
            budget {ms(budgetMs)} · {versioned ? 'versioned: cache-first' : 'perishable: live, snapshot fallback'}
            {hedged ? ' · hedged' : ''}
          </div>
        </div>
        <BreakerBadge state={s.breaker} />
      </div>
      <div className="mb-3 grid grid-cols-3 gap-2 text-center">
        {(['p50', 'p95', 'p99'] as const).map((p) => (
          <div key={p} className="rounded-md bg-slate-50 py-1.5">
            <div className="text-[10px] font-semibold uppercase text-slate-500">{p}</div>
            <div className={`text-sm font-semibold tabular-nums ${(s[p] ?? 0) > budgetMs ? 'text-red-700' : 'text-slate-900'}`}>{ms(s[p])}</div>
          </div>
        ))}
      </div>
      <div className="space-y-1">
        <Row label="Calls (ok / failed / short-circuited)" value={`${s.calls - s.short_circuit} (${s.ok} / ${failures} / ${s.short_circuit})`} warn={failures > s.ok} />
        {versioned && <Row label="Cache hit rate" value={`${pct(s.cacheHitRate)} (${s.cacheHit} hits, ${s.cacheStale} stale version)`} />}
        {hedged && <Row label="Hedges fired / won / skipped (budget)" value={`${s.hedgesFired} / ${s.hedgesWon} / ${s.hedgesSkipped}`} />}
        <Row label="Coalesced into an in-flight call" value={s.coalesced} />
        {server && (
          <>
            <Row label="Server: in flight / queued (max)" value={`${server.inflight} / ${server.queued} (${server.maxInflight})`} />
            <Row label="Server: abandoned at deadline / wasted" value={`${server.abandoned} / ${server.wasted}`} warn={server.wasted > 0} />
          </>
        )}
        {knobs && (
          <div className="pt-1 text-[11px] text-slate-400">
            knobs: {knobs.latencyMs} ms median, {knobs.tailPct}% tail at {knobs.tailMs} ms, {knobs.errorRate}% errors, {knobs.concurrency} workers{knobs.down ? ', DOWN' : ''}
          </div>
        )}
      </div>
    </section>
  )
}
