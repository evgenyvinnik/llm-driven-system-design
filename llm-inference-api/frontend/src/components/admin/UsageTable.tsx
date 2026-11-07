import { int, ms } from '@/lib/format'
import type { TenantUsage } from '@/types'

export function UsageTable({ usage }: { usage: TenantUsage[] }) {
  return (
    <section className="card overflow-hidden" aria-label="Usage per tenant">
      <div className="flex items-baseline justify-between border-b border-slate-100 px-4 py-2.5">
        <h2 className="panel-title">Usage per tenant (last 60 min)</h2>
        <span className="text-xs text-slate-500">429 = over the tenant's own limit · 529 = system over capacity</span>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-100" aria-label="Tenants">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">Tenant</th>
              <th className="th text-right">Requests</th>
              <th className="th text-right">Input (cached)</th>
              <th className="th text-right">Output</th>
              <th className="th text-right">Refunded</th>
              <th className="th text-right">Queue p50 / p95</th>
              <th className="th text-right">First token p50</th>
              <th className="th text-right">429</th>
              <th className="th text-right">529</th>
            </tr>
          </thead>
          <tbody className="num divide-y divide-slate-100">
            {usage.map((u) => (
              <tr key={u.orgId}>
                <td className="td whitespace-nowrap">
                  <span className="font-medium text-slate-800">{u.orgName}</span> <span className="text-xs text-slate-500">{u.tier}</span>
                </td>
                <td className="td text-right">
                  {int(u.requests)}
                  {u.failed + u.cancelled > 0 && <span className="text-xs text-slate-500"> ({u.cancelled} cancelled, {u.failed} failed)</span>}
                </td>
                <td className="td text-right">{int(u.inputTokens)} <span className="text-xs text-slate-500">({int(u.cachedTokens)})</span></td>
                <td className="td text-right">{int(u.outputTokens)}</td>
                <td className="td text-right">{int(u.refundedTokens)}</td>
                <td className="td text-right">{ms(u.p50QueueMs)} / {ms(u.p95QueueMs)}</td>
                <td className="td text-right">{ms(u.p50TtftMs)}</td>
                <td className={`td text-right ${u.rateLimited > 0 ? 'font-semibold text-amber-700' : ''}`}>{int(u.rateLimited)}</td>
                <td className={`td text-right ${u.overloaded > 0 ? 'font-semibold text-red-700' : ''}`}>{int(u.overloaded)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
