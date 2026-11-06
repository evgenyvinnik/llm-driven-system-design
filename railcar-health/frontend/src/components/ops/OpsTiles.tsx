import { StatTile } from '@/components/shared/PageHeader'
import type { OpsOverview } from '@/types'
import { Sparkline } from './Sparkline'

export function OpsTiles({ o }: { o: OpsOverview }) {
  const staleness = Math.max(0, ...o.groups.filter((g) => g.kind === 'projection').map((g) => g.stalenessSeconds))
  const lag = o.groups.reduce((s, g) => s + g.lag + g.pending, 0)
  return (
    <div className="grid grid-cols-6 gap-3">
      <div className="card col-span-2 px-4 py-3">
        <div className="flex items-baseline justify-between">
          <div className="panel-title">Events / second</div>
          <div className="text-xs text-slate-500">{o.eventsPerSecond.last10s} (10 s) · {o.eventsPerSecond.last60s} (60 s)</div>
        </div>
        <Sparkline series={o.eventsPerSecond.series} />
      </div>
      <StatTile label="Event store head" value={`#${o.head.position.toLocaleString()}`} hint={`${o.head.totalEvents.toLocaleString()} events, append-only`} />
      <StatTile label="Relay lag" value={o.relay.lag} hint={`outbox → streams; published up to #${o.relay.checkpoint.toLocaleString()}`} />
      <StatTile label="Consumer lag" value={lag} hint={`messages not yet handled, all groups · projections ${staleness.toFixed(1)} s stale`} />
      <StatTile label="Dead letters" value={<span className={o.dlq.depth > 0 ? 'text-red-700' : ''}>{o.dlq.depth}</span>} hint={`timers: ${o.timers.pending} pending, ${o.timers.overdue} overdue, ${o.timers.fired} fired`} />
    </div>
  )
}
