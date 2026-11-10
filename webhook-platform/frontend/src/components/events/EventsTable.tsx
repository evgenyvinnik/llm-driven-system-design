import { Link } from '@tanstack/react-router'
import { TypeChip } from '@/components/shared/Chips'
import { Empty } from '@/components/shared/Loading'
import { ago, shortId } from '@/lib/format'
import type { EventItem } from '@/types'

export function EventsTable({ events }: { events: EventItem[] }) {
  if (events.length === 0) return <Empty>No events yet. Send one, or run <span className="code">npm run demo:story</span>.</Empty>
  return (
    <div className="overflow-x-auto">
      <table className="w-full" aria-label="Events">
        <thead className="border-b border-slate-200 bg-slate-50">
          <tr>
            <th className="th">Event</th>
            <th className="th">Type</th>
            <th className="th">Ordering</th>
            <th className="th">Deliveries</th>
            <th className="th">Source</th>
            <th className="th">Created</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {events.map((e) => (
            <tr key={e.id} className="hover:bg-slate-50">
              <td className="td">
                <Link to="/events/$eventId" params={{ eventId: e.id }} className="font-mono text-xs text-accent-700 hover:underline">{shortId(e.id)}</Link>
              </td>
              <td className="td"><TypeChip type={e.type} /></td>
              <td className="td font-mono text-xs text-slate-600">{e.orderingKey ? `${e.orderingKey} #${e.sequence}` : '—'}</td>
              <td className="td text-xs">
                {e.deliveries && (
                  <span className="num">
                    <span className="text-emerald-700">{e.deliveries.delivered} delivered</span>
                    {e.deliveries.pending > 0 && <span className="text-amber-700"> · {e.deliveries.pending} pending</span>}
                    {e.deliveries.failed > 0 && <span className="text-red-700"> · {e.deliveries.failed} failed</span>}
                    {e.deliveries.total === 0 && <span className="text-slate-400">no matching endpoint</span>}
                  </span>
                )}
              </td>
              <td className="td text-xs text-slate-500">{e.source}</td>
              <td className="td text-xs text-slate-500">{ago(e.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
