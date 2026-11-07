import { SourceBadge } from '@/components/shared/Badges'
import { age, COMPONENT_LABEL, money, ms } from '@/lib/format'
import type { PriceComponent } from '@/types'

/** Price provenance: where each component came from, which version, how old, and why it may be stale. */
export function ComponentTable({ components, quantity }: { components: PriceComponent[]; quantity: number }) {
  return (
    <section className="card overflow-hidden" aria-label="Price components">
      <div className="border-b border-slate-100 px-4 py-2.5 panel-title">Price components and provenance</div>
      <table className="w-full" aria-label="Components">
        <thead className="bg-slate-50">
          <tr>
            <th className="th">Component</th>
            <th className="th text-right">Per car</th>
            <th className="th">Source</th>
            <th className="th">Based on</th>
            <th className="th text-right">Age</th>
            <th className="th text-right">Latency</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {components.map((c) => (
            <tr key={c.component} className="align-top">
              <td className="td font-medium text-slate-900">{COMPONENT_LABEL[c.component]}</td>
              <td className="td text-right tabular-nums">{money(c.amountCentsPerCar)}</td>
              <td className="td">
                <SourceBadge source={c.source} />
              </td>
              <td className="td">
                <div className="font-mono text-xs text-slate-700">{c.basis}</div>
                {c.staleness && <div className="mt-1 max-w-md text-xs text-amber-800">{c.staleness}</div>}
                {c.component === 'capacity_premium' && typeof c.detail.utilizationPct === 'number' && (
                  <div className="mt-1 text-xs text-slate-500">
                    lane {String(c.detail.utilizationPct)}% utilized · premium {String(c.detail.premiumPct)}% · {String(c.detail.transitDays)} days transit
                    {c.detail.hedged ? ' · hedged' : ''}
                    {c.detail.coalesced ? ' · coalesced' : ''}
                  </div>
                )}
                {c.component === 'equipment' && typeof c.detail.carsAvailable === 'number' && (
                  <div className="mt-1 text-xs text-slate-500">
                    {String(c.detail.carsAvailable)} {c.detail.carsAvailable === 1 ? 'car' : 'cars'} near origin · placement in {String(c.detail.placementDays)} days
                  </div>
                )}
              </td>
              <td className="td text-right text-xs tabular-nums text-slate-500">{c.source === 'live' ? 'now' : age(c.ageSeconds)}</td>
              <td className="td text-right text-xs tabular-nums text-slate-500">{ms(c.latencyMs)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-slate-50">
          <tr>
            <td className="td font-semibold">Total × {quantity} cars</td>
            <td className="td text-right font-semibold tabular-nums">{money(components.reduce((s, c) => s + c.amountCentsPerCar, 0) * quantity)}</td>
            <td className="td" colSpan={4} />
          </tr>
        </tfoot>
      </table>
    </section>
  )
}
