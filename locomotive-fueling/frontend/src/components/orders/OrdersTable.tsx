import { Fragment, useState } from 'react'
import { OrderStatus } from '@/components/shared/Chips'
import { gal, relHours, simTime } from '@/lib/format'
import { api } from '@/services/api'
import type { OrderRow } from '@/types'

/** DTL orders with their full event trail: what we sent, what we heard, and what we did about silence. */
export function OrdersTable({ orders, nowMs, onChanged }: { orders: OrderRow[]; nowMs: number; onChanged: () => void }) {
  const [open, setOpen] = useState<number | null>(orders.find((o) => o.events.some((e) => e.to === 'unknown'))?.id ?? null)
  if (orders.length === 0) return <div className="card p-4 text-sm text-slate-600">No DTL orders yet. A truck is ordered only for an accepted DTL stop within the ordering window.</div>
  return (
    <div className="card overflow-hidden">
      <table className="w-full" aria-label="DTL orders">
        <thead className="bg-slate-50">
          <tr>
            <th className="th">Stop (idempotency key)</th>
            <th className="th">Train</th>
            <th className="th">Status</th>
            <th className="th text-right">Gallons</th>
            <th className="th">Train ETA</th>
            <th className="th">Attempts</th>
            <th className="th" />
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <Fragment key={o.id}>
              <tr className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => setOpen(open === o.id ? null : o.id)}>
                <td className="td">
                  <div className="font-medium text-slate-900">{o.locationName}</div>
                  <div className="font-mono text-[11px] text-slate-500">{o.stopKey}</div>
                  <div className="text-[11px] text-slate-500">{o.vendor}{o.vendorOrderId ? ` · ${o.vendorOrderId}` : ''}</div>
                </td>
                <td className="td">{o.symbol}</td>
                <td className="td">
                  <OrderStatus status={o.status} />
                  {o.lastError && <div className="mt-0.5 max-w-xs text-[11px] text-slate-500">{o.lastError}</div>}
                </td>
                <td className="td num text-right">
                  {gal(o.gallonsRequested)}
                  {o.gallonsDelivered !== null && <div className="text-[11px] text-slate-500">delivered {gal(o.gallonsDelivered)}</div>}
                </td>
                <td className="td num text-xs">
                  {simTime(o.etaMs)}
                  <div className="text-slate-500">{relHours(o.etaMs, nowMs)}</div>
                </td>
                <td className="td num">{o.attempts}</td>
                <td className="td text-right">
                  {['pending', 'unknown', 'confirmed'].includes(o.status) && (
                    <button
                      type="button"
                      className="btn-danger px-2 py-1 text-xs"
                      onClick={(e) => {
                        e.stopPropagation()
                        void api.cancelOrder(o.id).then(onChanged)
                      }}
                    >
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
              {open === o.id && (
                <tr className="bg-slate-50/70">
                  <td colSpan={7} className="px-6 py-3">
                    <ol className="space-y-1 border-l-2 border-slate-200 pl-4 text-xs">
                      {o.events.map((e, i) => (
                        <li key={i}>
                          <span className="font-medium text-slate-800">{e.from ? `${e.from} → ${e.to}` : e.to}</span>
                          <span className="ml-2 text-slate-600">{e.note}</span>
                          <span className="ml-2 text-slate-400">{new Date(e.at).toLocaleTimeString()}</span>
                        </li>
                      ))}
                    </ol>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}
