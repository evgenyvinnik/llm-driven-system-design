import { num, pct, pValue, signedPct, VARIANT_COLORS } from '@/lib/format'
import type { Analysis } from '@/types'
import { CiBar } from './CiBar'

export function ArmsTable({ analysis, names, label }: { analysis: Analysis; names: Record<string, string>; label: string }) {
  const max = Math.max(0.01, ...analysis.arms.map((a) => a.ci[1])) * 1.15
  return (
    <table className="w-full" aria-label={label}>
      <thead className="border-b border-slate-200 bg-slate-50">
        <tr>
          <th className="th">Variant</th>
          <th className="th text-right">Units</th>
          <th className="th text-right">Crossovers excluded</th>
          <th className="th text-right">Converted</th>
          <th className="th">Conversion rate (95% Wilson CI)</th>
          <th className="th text-right">Lift vs control</th>
          <th className="th text-right">p-value</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {analysis.arms.map((a, i) => (
          <tr key={a.variant} data-variant={a.variant}>
            <td className="td">
              <div className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-sm ${VARIANT_COLORS[i % VARIANT_COLORS.length]}`} />
                <code className="code">{a.variant}</code>
              </div>
              <div className="mt-0.5 text-xs text-slate-500">{names[a.variant]}</div>
            </td>
            <td className="td num text-right">{num(a.units)}</td>
            <td className="td num text-right text-slate-500">{a.crossovers > 0 ? num(a.crossovers) : '—'}</td>
            <td className="td num text-right">
              {num(a.conversions)} <span className="text-xs text-slate-400">/ {num(a.analyzedUnits)}</span>
            </td>
            <td className="td">
              <div className="flex items-center gap-3">
                <span className="num w-14 text-right font-semibold">{pct(a.rate, 2)}</span>
                <CiBar rate={a.rate} ci={a.ci} max={max} tone={VARIANT_COLORS[i % VARIANT_COLORS.length]} />
              </div>
              <div className="num ml-[68px] text-[11px] text-slate-400">
                {pct(a.ci[0], 2)} – {pct(a.ci[1], 2)}
              </div>
            </td>
            <td className="td num text-right">
              {a.lift ? (
                <>
                  <span className={`font-semibold ${a.lift.significant ? (a.lift.absDiff > 0 ? 'text-emerald-700' : 'text-rose-700') : 'text-slate-700'}`}>{signedPct(a.lift.relLift)}</span>
                  <div className="text-[11px] text-slate-400">
                    [{signedPct(a.lift.relLow)}, {signedPct(a.lift.relHigh)}]
                  </div>
                </>
              ) : (
                <span className="text-xs text-slate-400">control</span>
              )}
            </td>
            <td className="td num text-right">
              {a.lift ? (
                <>
                  {pValue(a.lift.pValue)}
                  <div>
                    <span className={`chip ${a.lift.significant ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-500'}`}>{a.lift.significant ? 'significant' : 'not significant'}</span>
                  </div>
                </>
              ) : (
                '—'
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
