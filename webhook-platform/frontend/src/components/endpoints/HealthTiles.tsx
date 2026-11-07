import { ClockIcon, PlugIcon, ReplayIcon, ShieldIcon } from '@/components/icons'
import { StatTile } from '@/components/shared/StatTile'
import { ago, ms, pct } from '@/lib/format'
import type { Endpoint } from '@/types'

export function HealthTiles({ endpoint: e }: { endpoint: Endpoint }) {
  const h = e.health
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile label="Success (1 h)" value={pct(h.successRate1h)} hint={`${h.attempts1h} attempts`} icon={<ShieldIcon />} />
      <StatTile label="Latency p50 / p95" value={`${ms(h.p50Ms)} / ${ms(h.p95Ms)}`} hint="per attempt, last hour" icon={<ClockIcon />} />
      <StatTile
        label="In flight / limit"
        value={`${h.inFlight} / ${h.effectiveConcurrency}`}
        hint={h.probing ? `probing (limit ${e.maxConcurrency} after recovery)` : 'requests open right now'}
        icon={<PlugIcon />}
      />
      <StatTile label="Waiting / failed" value={`${h.waiting} / ${h.failed}`} hint={`last success ${ago(e.lastSuccessAt)}`} icon={<ReplayIcon />} />
    </div>
  )
}
