import { Link } from '@tanstack/react-router'
import { dateTime, money, shortId } from '@/lib/format'
import { api } from '@/services/api'
import type { Delivery, Receipt } from '@/types'

interface Props {
  deliveries: Delivery[]
  receipts: Receipt[]
  failNext: number
  onChange: () => void
}

/** Signed callbacks: what we sent (at least once) and what the customer's receiver kept (deduplicated). */
export function Deliveries({ deliveries, receipts, failNext, onChange }: Props) {
  return (
    <section className="card overflow-hidden" aria-label="Webhook deliveries">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
        <div className="panel-title">Webhook deliveries</div>
        <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => void api.receiverKnobs({ failNext: 3 }).then(onChange)}>
          Receiver: fail next 3 {failNext > 0 ? `(${failNext} left)` : ''}
        </button>
      </div>
      <table className="w-full" aria-label="Deliveries">
        <thead className="bg-slate-50">
          <tr>
            <th className="th">Created</th>
            <th className="th">Quote</th>
            <th className="th">Customer</th>
            <th className="th">Status</th>
            <th className="th text-right">Attempts</th>
            <th className="th">Receiver kept</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {deliveries.slice(0, 12).map((d) => {
            const r = receipts.find((x) => x.eventId === d.event_id)
            return (
              <tr key={d.id}>
                <td className="td text-xs text-slate-500">{dateTime(d.created_at)}</td>
                <td className="td font-mono text-xs">
                  {d.quote_id && (
                    <Link to="/quotes/$quoteId" params={{ quoteId: d.quote_id }} className="text-accent-700 hover:underline">
                      {shortId(d.quote_id)}
                    </Link>
                  )}
                </td>
                <td className="td text-xs">{d.customer_name}</td>
                <td className="td text-xs">
                  <span className={`chip ${d.status === 'delivered' ? 'bg-emerald-100 text-emerald-800' : d.status === 'dead' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}`}>{d.status}</span>
                  {d.last_error && <div className="mt-0.5 text-[11px] text-slate-500">{d.last_error}</div>}
                </td>
                <td className="td text-right tabular-nums">{d.attempts}</td>
                <td className="td text-xs">
                  {r ? `once (${money(r.totalCents ?? 0)}), received ${r.deliveries}×` : '—'}
                  {d.status === 'dead' && (
                    <button type="button" className="btn-ghost ml-2 px-1.5 py-0.5 text-xs" onClick={() => void api.retryDelivery(d.id).then(onChange)}>
                      Retry
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
          {deliveries.length === 0 && (
            <tr>
              <td colSpan={6} className="px-4 py-6 text-center text-sm text-slate-500">
                No callbacks yet. Request an indicative quote with the webhook option on.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  )
}
