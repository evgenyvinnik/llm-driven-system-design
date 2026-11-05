import { money } from '@/lib/format'
import type { Plan } from '@/types'

/** What the optimizer minimizes, line by line, and how the classic greedy plan compares. */
export function CostCard({ plan }: { plan: Plan }) {
  const c = plan.costBreakdown
  const rows: [string, number, string?][] = [
    ['Fuel purchases', c.fuel],
    ['DTL truck fees', c.fees],
    ['Delay (dwell × train-hour cost)', c.delay],
    ['Stop penalties', c.stops],
    ['Cancellation fees', c.cancellations],
    ['Credit: fuel carried to destination', -c.terminalCredit, 'Valued below the destination price: the next trip can buy elsewhere'],
  ]
  const savings = plan.greedyCost !== null ? plan.greedyCost - plan.costTotal : null
  return (
    <div className="card p-4">
      <div className="panel-title mb-2">Objective (expected)</div>
      <table className="w-full text-sm">
        <tbody>
          {rows
            .filter(([, v]) => Math.abs(v) >= 0.5)
            .map(([label, v, hint]) => (
              <tr key={label} title={hint}>
                <td className="py-0.5 text-slate-600">{label}</td>
                <td className="num py-0.5 text-right text-slate-800">{money(v)}</td>
              </tr>
            ))}
          <tr className="border-t border-slate-200">
            <td className="pt-1 font-semibold text-slate-900">Net trip fuel cost</td>
            <td className="num pt-1 text-right font-semibold text-slate-900">{money(c.total)}</td>
          </tr>
        </tbody>
      </table>
      {plan.greedyCost !== null && (
        <div className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
          Greedy &ldquo;buy just enough to reach cheaper fuel&rdquo; plan: <span className="font-medium">{plan.greedyStops}</span>, {money(plan.greedyCost)}.{' '}
          {savings !== null && Math.abs(savings) < 50 ? 'About the same here.' : savings !== null && savings > 0 ? `This plan saves ${money(savings)} by weighing fees and dwell.` : ''}
        </div>
      )}
    </div>
  )
}
