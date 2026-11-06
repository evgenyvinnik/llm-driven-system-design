import { createFileRoute, Link } from '@tanstack/react-router'
import { Histogram } from '@/components/latency/Histogram'
import { LaneCompare } from '@/components/latency/LaneCompare'
import { StageBars } from '@/components/latency/StageBars'
import { LaneBadge, LateBadge } from '@/components/shared/Badges'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { PageHeader, StatTile } from '@/components/shared/PageHeader'
import { KIND_LABEL, msText, timeText } from '@/lib/format'
import { useFetch } from '@/lib/hooks'
import { api } from '@/services/api'
import { useLiveStore } from '@/stores/live-store'
import type { HazardKind } from '@/types'

export const Route = createFileRoute('/latency')({ component: LatencyPage })

export function LatencyPage() {
  const rev = useLiveStore((s) => s.revisions)
  const { data, error } = useFetch(() => api.latency(), [rev.latency, rev.alerts])
  if (error && !data) return <div className="page"><ErrorNote message={error} /></div>
  if (!data) return <Loading />
  const live = data.alerts.live
  return (
    <div className="page space-y-4">
      <PageHeader title="Latency budget" subtitle="From the moment the edge detected something to the alert on the dispatcher's console. Budget: a few seconds for live data." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="Detection → alert p50" value={msText(live.p50)} hint={`${live.count} live alerts`} />
        <StatTile label="Detection → alert p99" value={<span className={(live.p99 ?? 0) > data.budgetMs ? 'text-red-600' : 'text-emerald-700'}>{msText(live.p99)}</span>} hint={`budget ${msText(data.budgetMs)}`} />
        <StatTile label="Critical lane p99" value={msText(data.decisions.critical.cloud.p99)} hint="ingest → correlator decision" />
        <StatTile label="Bulk lane p99" value={msText(data.decisions.bulk.cloud.p99)} hint="backlogs wait here, not in critical" />
        <StatTile label="Late alerts" value={data.alerts.late.count} hint={`p50 ${msText(data.alerts.late.p50)} (edge was offline)`} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <section className="card p-4">
          <h2 className="panel-title mb-3">Where the time goes (live alerts)</h2>
          <StageBars stages={data.stages} />
        </section>
        <section className="card p-4">
          <h2 className="panel-title mb-3">Detection → alert distribution</h2>
          <Histogram values={data.histogram} budgetMs={data.budgetMs} />
        </section>
      </div>
      <section className="card p-4">
        <h2 className="panel-title mb-3">Priority lanes: cloud processing time per lane (last 6 h)</h2>
        <LaneCompare decisions={data.decisions} />
      </section>
      <section className="card overflow-x-auto">
        <h2 className="panel-title border-b border-slate-100 px-4 py-2.5">Recent alerts</h2>
        <table className="min-w-full" aria-label="Latency samples">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">Hazard</th>
              <th className="th">Lane</th>
              <th className="th">Edge → ingest</th>
              <th className="th">→ detected</th>
              <th className="th">→ alert</th>
              <th className="th">→ console</th>
              <th className="th">Total</th>
              <th className="th">Delivered</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.samples.map((s, i) => (
              <tr key={`${s.hazardId}-${i}`}>
                <td className="td">
                  <Link to="/hazards/$hazardId" params={{ hazardId: s.hazardId }} className="text-accent-700 hover:underline">
                    {s.code}
                  </Link>{' '}
                  {s.kind ? KIND_LABEL[s.kind as HazardKind] : ''} <LateBadge late={s.late} />
                </td>
                <td className="td"><LaneBadge lane={s.lane} /></td>
                <td className="td">{msText(s.stages.edgeToIngest)}</td>
                <td className="td">{msText(s.stages.ingestToDetect)}</td>
                <td className="td">{msText(s.stages.detectToAlert)}</td>
                <td className="td">{msText(s.stages.alertToDelivered)}</td>
                <td className="td font-semibold">{msText(s.totalMs)}</td>
                <td className="td text-xs">{timeText(s.deliveredAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}
