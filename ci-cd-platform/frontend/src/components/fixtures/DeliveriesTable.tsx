import { Link } from '@tanstack/react-router'
import { GitForkIcon, ReplayIcon } from '@/components/icons'
import { shortSha, timeAgo } from '@/lib/format'
import type { Delivery } from '@/types'

const OUTCOME: Record<string, string> = { created_run: 'run created', no_workflow: 'no workflow file', filtered: 'filtered by on:', unknown_commit: 'unknown commit' }

export function DeliveriesTable({ deliveries, canRedeliver, onRedeliver }: { deliveries: Delivery[]; canRedeliver: (repoId: string) => boolean; onRedeliver: (d: Delivery) => void }) {
  return (
    <table className="w-full" aria-label="Deliveries">
      <thead className="border-b border-slate-100">
        <tr>
          <th className="th">Delivery id</th>
          <th className="th">Repository</th>
          <th className="th">Event</th>
          <th className="th">Commit</th>
          <th className="th">Outcome</th>
          <th className="th">Received</th>
          <th className="th" />
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {deliveries.map((d) => (
          <tr key={`${d.repoId}-${d.deliveryId}`}>
            <td className="td font-mono text-xs" title={d.deliveryId}>
              {d.deliveryId.slice(0, 20)}
            </td>
            <td className="td text-xs">{d.repository}</td>
            <td className="td text-xs">
              {d.isFork && <GitForkIcon className="mr-1 inline h-3 w-3 text-orange-700" />}
              {d.eventType} on {d.branch}
            </td>
            <td className="td font-mono text-xs">{shortSha(d.commitSha)}</td>
            <td className="td text-xs">
              {d.runId ? (
                <Link to="/runs/$runId" params={{ runId: d.runId }} className="link">
                  run #{d.runNumber}
                </Link>
              ) : (
                OUTCOME[d.outcome] ?? d.outcome
              )}
            </td>
            <td className="td text-xs">
              {timeAgo(d.createdAt)}
              {d.redeliveries > 0 && <span className="ml-1 font-medium text-accent-700">, {d.redeliveries + 1}× in total</span>}
            </td>
            <td className="td text-right">
              {canRedeliver(d.repoId) && (
                <button type="button" className="btn-secondary !py-1 !text-xs" title="Sends the same event with the same delivery id" onClick={() => onRedeliver(d)}>
                  <ReplayIcon className="h-3.5 w-3.5" /> Send again
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
