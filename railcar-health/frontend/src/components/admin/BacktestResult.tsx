import { pct } from '@/lib/format'
import type { Backtest } from '@/types'

export function BacktestResult({ result }: { result: Backtest }) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-500">Re-scored {result.sample} inspected alerts with their stored features. Precision = share of inspected alerts in the tier where a defect was found.</p>
      <table className="w-full text-sm" aria-label="Backtest">
        <thead className="border-b border-slate-100">
          <tr><th className="th">Tier</th><th className="th">Current alerts</th><th className="th">Current precision</th><th className="th">Proposed alerts</th><th className="th">Proposed precision</th></tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {result.current.byTier.map((c, i) => {
            const p = result.proposed.byTier[i]
            return (
              <tr key={c.tier}>
                <td className="td font-medium">{c.tier}</td>
                <td className="td">{c.alerts}</td>
                <td className="td">{pct(c.precision)}</td>
                <td className={`td ${p.alerts !== c.alerts ? 'font-semibold text-slate-900' : ''}`}>{p.alerts}</td>
                <td className="td">{pct(p.precision)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className={`text-sm ${result.missedDefects > 0 ? 'text-red-700' : 'text-slate-600'}`}>
        Actionable (MEDIUM+): {result.current.actionable} → {result.proposed.actionable} alerts.
        {result.missedDefects > 0 ? ` ${result.missedDefects} confirmed defect(s) would drop below MEDIUM.` : ' No confirmed defect drops below MEDIUM.'}
        {result.newlyCaught > 0 && ` ${result.newlyCaught} defect(s) newly reach MEDIUM.`}
      </p>
    </div>
  )
}
