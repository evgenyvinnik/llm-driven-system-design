import { StatTile } from '@/components/shared/PageHeader'
import { msText } from '@/lib/format'
import type { Board } from '@/types'

export function KpiRow({ board }: { board: Board }) {
  const k = board.kpis
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <StatTile label="Open critical" value={<span className={k.openCritical ? 'text-sev-critical' : ''}>{k.openCritical}</span>} hint={`${k.openHazards} open hazards`} />
      <StatTile label="Unacknowledged" value={<span className={k.unacknowledged ? 'text-red-600' : ''}>{k.unacknowledged}</span>} hint="alerts awaiting a dispatcher" />
      <StatTile label="Slow orders" value={k.activeRestrictions} hint="active speed restrictions" />
      <StatTile label="Coverage gaps" value={<span className={k.degradedSegments ? 'text-red-600' : ''}>{k.degradedSegments}</span>} hint="segments with degraded coverage" />
      <StatTile label="Detection → alert p50" value={msText(k.alertP50Ms)} hint="edge event to console, live data" />
      <StatTile label="Detection → alert p99" value={msText(k.alertP99Ms)} hint="budget: seconds, not minutes" />
    </div>
  )
}
