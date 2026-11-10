import { Link } from '@tanstack/react-router'
import { EndpointStatusChip } from '@/components/shared/Chips'
import { SuccessBar } from '@/components/shared/SuccessBar'
import { ago, ms } from '@/lib/format'
import type { Endpoint } from '@/types'

export function EndpointsTable({ endpoints }: { endpoints: Endpoint[] }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full" aria-label="Endpoints">
        <thead className="border-b border-slate-200 bg-slate-50">
          <tr>
            <th className="th">Endpoint</th>
            <th className="th">Event types</th>
            <th className="th">Status</th>
            <th className="th">Success (1 h)</th>
            <th className="th">p95</th>
            <th className="th">In flight</th>
            <th className="th">Waiting / failed</th>
            <th className="th">Last success</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {endpoints.map((e) => (
            <tr key={e.id} className="hover:bg-slate-50">
              <td className="td">
                <Link to="/endpoints/$endpointId" params={{ endpointId: e.id }} className="font-medium text-accent-700 hover:underline">
                  {e.description || e.id}
                </Link>
                <div className="max-w-xs truncate font-mono text-xs text-slate-500">{e.url}</div>
              </td>
              <td className="td">
                <div className="flex flex-wrap gap-1">
                  {e.eventTypes.map((t) => (
                    <span key={t} className="chip bg-slate-100 font-mono text-slate-700">{t}</span>
                  ))}
                </div>
              </td>
              <td className="td">
                <EndpointStatusChip status={e.status} probing={e.health.probing} paused={Boolean(e.pausedUntil)} />
                {e.consecutiveFailures > 0 && <div className="mt-1 text-xs text-slate-500">{e.consecutiveFailures} failures in a row</div>}
              </td>
              <td className="td"><SuccessBar rate={e.health.successRate1h} attempts={e.health.attempts1h} /></td>
              <td className="td num">{ms(e.health.p95Ms)}</td>
              <td className="td num">
                {e.health.inFlight} <span className="text-slate-400">/ {e.health.effectiveConcurrency}</span>
              </td>
              <td className="td num">
                {e.health.waiting} <span className="text-slate-400">/</span> <span className={e.health.failed > 0 ? 'text-red-700' : ''}>{e.health.failed}</span>
              </td>
              <td className="td text-xs text-slate-600">{ago(e.lastSuccessAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
