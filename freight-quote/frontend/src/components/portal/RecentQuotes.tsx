import { Link } from '@tanstack/react-router'
import { KindBadge, StatusBadge } from '@/components/shared/Badges'
import { CLASS_LABEL, dateTime, money, shortId, validity } from '@/lib/format'
import type { Quote } from '@/types'

export function RecentQuotes({ quotes, showCustomer }: { quotes: Quote[]; showCustomer?: boolean }) {
  if (quotes.length === 0) return <p className="text-sm text-slate-500">No quotes yet.</p>
  return (
    <div className="card overflow-hidden">
      <table className="w-full" aria-label="Quotes">
        <thead className="bg-slate-50">
          <tr>
            <th className="th">Quote</th>
            <th className="th">Requested</th>
            {showCustomer && <th className="th">Customer</th>}
            <th className="th">Lane</th>
            <th className="th">Kind</th>
            <th className="th text-right">Total</th>
            <th className="th">Status</th>
            <th className="th">Validity</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {quotes.map((q) => (
            <tr key={q.id} className="hover:bg-slate-50">
              <td className="td font-mono text-xs">
                <Link to="/quotes/$quoteId" params={{ quoteId: q.id }} className="text-accent-700 hover:underline">
                  {shortId(q.id)}
                </Link>
              </td>
              <td className="td text-xs text-slate-500">{dateTime(q.createdAt)}</td>
              {showCustomer && (
                <td className="td text-xs">
                  {q.customerName} <span className="text-slate-400">· {CLASS_LABEL[q.clientClass]}</span>
                </td>
              )}
              <td className="td">
                {q.origin} → {q.destination} <span className="text-xs text-slate-400">{q.commodity.toLowerCase()} × {q.quantity}</span>
              </td>
              <td className="td">
                <KindBadge quote={q} />
              </td>
              <td className="td text-right tabular-nums">{money(q.totalCents)}</td>
              <td className="td">
                <StatusBadge status={q.status} />
              </td>
              <td className="td text-xs text-slate-500">{q.status === 'open' ? validity(q.validUntil).label : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
