import { Link } from '@tanstack/react-router'
import { ErrorClassText, StateChip, TypeChip } from '@/components/shared/Chips'
import { Empty } from '@/components/shared/Loading'
import { ago, shortId, until } from '@/lib/format'
import type { Delivery } from '@/types'

const FILTERS = [
  { key: '', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'failed', label: 'Failed' },
] as const

export function DeliveryFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex gap-1" role="tablist" aria-label="Delivery state">
      {FILTERS.map((f) => (
        <button
          key={f.key}
          type="button"
          role="tab"
          aria-selected={value === f.key}
          className={`rounded-md px-2.5 py-1 text-xs font-medium ${value === f.key ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
          onClick={() => onChange(f.key)}
        >
          {f.label}
        </button>
      ))}
    </div>
  )
}

export function DeliveriesTable({ deliveries, showEndpoint = false }: { deliveries: Delivery[]; showEndpoint?: boolean }) {
  if (deliveries.length === 0) return <Empty>No deliveries yet.</Empty>
  return (
    <div className="overflow-x-auto">
      <table className="w-full" aria-label="Deliveries">
        <thead className="border-b border-slate-200 bg-slate-50">
          <tr>
            <th className="th">Delivery</th>
            <th className="th">{showEndpoint ? 'Endpoint' : 'Event'}</th>
            <th className="th">State</th>
            <th className="th">Attempts</th>
            <th className="th">Last result</th>
            <th className="th">Next attempt</th>
            <th className="th">Created</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {deliveries.map((d) => (
            <tr key={d.id} className="hover:bg-slate-50">
              <td className="td">
                <Link to="/deliveries/$deliveryId" params={{ deliveryId: d.id }} className="font-mono text-xs text-accent-700 hover:underline">
                  {shortId(d.id)}
                </Link>
                {d.replayCount > 0 && <div className="text-[11px] text-slate-500">replayed ×{d.replayCount}</div>}
              </td>
              <td className="td">
                {showEndpoint ? (
                  <span className="text-sm">{d.endpointDescription}</span>
                ) : (
                  <div className="space-y-0.5">
                    {d.eventType && <TypeChip type={d.eventType} />}
                    {d.orderingKey && <div className="font-mono text-[11px] text-slate-500">{d.orderingKey} #{d.sequence}</div>}
                  </div>
                )}
              </td>
              <td className="td"><StateChip state={d.state} /></td>
              <td className="td num">{d.attemptCount}</td>
              <td className="td text-xs">
                {d.lastStatusCode !== null && <span className="num mr-1 font-mono">{d.lastStatusCode}</span>}
                <ErrorClassText errorClass={d.lastErrorClass} />
              </td>
              <td className="td text-xs text-slate-600">{d.state === 'scheduled' ? `in ${until(d.nextAttemptAt)}` : '—'}</td>
              <td className="td text-xs text-slate-500">{ago(d.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
