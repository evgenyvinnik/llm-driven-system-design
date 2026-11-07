import { createFileRoute } from '@tanstack/react-router'
import { ClockIcon, GaugeIcon, InboxIcon, ShieldIcon } from '@/components/icons'
import { OpsEndpointsTable } from '@/components/ops/OpsEndpointsTable'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { StatTile } from '@/components/shared/StatTile'
import { ms, pct } from '@/lib/format'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'

export const Route = createFileRoute('/ops')({ component: OpsPage })

function OpsPage() {
  const { data, error } = usePoll(() => api.ops(), 2000)
  if (error) return <div className="page"><ErrorNote message={error} /></div>
  if (!data) return <Loading />
  const q = data.queue
  const states = data.deliveriesByState
  return (
    <div className="page">
      <div>
        <h1 className="h1">Operations</h1>
        <p className="mt-1 text-sm text-slate-500">
          Fleet-wide delivery health. Retries wait in PostgreSQL, so the queue should stay near zero even while an endpoint is down.
          Retry window {data.policy.retryHorizonSeconds}s · backoff {ms(data.policy.backoffBaseMs)}→{ms(data.policy.backoffCapMs)} · timeout {ms(data.policy.timeoutMs)}.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Queue ready / unacked" value={q.ready === null ? 'n/a' : `${q.ready} / ${q.unacked}`} hint={q.consumers === null ? 'management API unreachable' : `${q.consumers} consumers · ${q.deliverRate?.toFixed(1)}/s out`} icon={<InboxIcon />} />
        <StatTile label="Outbox backlog" value={data.outbox.unpublished} hint={data.outbox.oldestSeconds ? `oldest ${data.outbox.oldestSeconds.toFixed(1)} s` : 'publisher keeping up'} icon={<ClockIcon />} />
        <StatTile label="Success rate (5 min)" value={pct(data.successRate5m)} hint={`${data.attempts5m} attempts`} icon={<ShieldIcon />} />
        <StatTile label="In flight / waiting" value={`${states.in_flight ?? 0} / ${(states.scheduled ?? 0) + (states.queued ?? 0)}`} hint={`${states.failed ?? 0} failed · ${states.delivered ?? 0} delivered · poison ${data.poison.ready ?? 'n/a'}`} icon={<GaugeIcon />} />
      </div>
      <section className="card">
        <h2 className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">Per customer (last 5 minutes)</h2>
        <div className="overflow-x-auto">
          <table className="w-full" aria-label="Customers">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="th">Org</th>
                <th className="th">Attempts</th>
                <th className="th">Success</th>
                <th className="th">Attempt p50 / p95</th>
                <th className="th">Event → delivered p50 / p95</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.orgs.map((o) => (
                <tr key={o.org}>
                  <td className="td font-medium">{o.org}</td>
                  <td className="td num">{o.attempts5m}</td>
                  <td className="td num">{pct(o.successRate5m)}</td>
                  <td className="td num">{ms(o.attemptP50Ms)} / {ms(o.attemptP95Ms)}</td>
                  <td className="td num">{ms(o.eventToDeliveredP50Ms)} / {ms(o.eventToDeliveredP95Ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <h2 className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">Endpoints</h2>
        <OpsEndpointsTable endpoints={data.endpoints} />
      </section>
    </div>
  )
}
