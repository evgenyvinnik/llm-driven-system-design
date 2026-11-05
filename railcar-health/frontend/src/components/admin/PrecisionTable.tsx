import { TierBadge } from '@/components/shared/TierBadge'
import { pct } from '@/lib/format'
import type { Metrics } from '@/types'

export function PrecisionTable({ rows }: { rows: Metrics['precisionByTier'] }) {
  return (
    <table className="w-full" aria-label="Precision by tier">
      <thead className="border-b border-slate-100">
        <tr><th className="th">Tier</th><th className="th">Inspected</th><th className="th">Defect</th><th className="th">None found</th><th className="th">Precision</th></tr>
      </thead>
      <tbody className="divide-y divide-slate-50">
        {rows.map((r) => (
          <tr key={r.tier}>
            <td className="td"><TierBadge tier={r.tier} /></td>
            <td className="td">{r.inspected}</td>
            <td className="td">{r.defects}</td>
            <td className="td">{r.noDefectFound}</td>
            <td className="td">
              <div className="flex items-center gap-2">
                <div className="h-2 w-12 overflow-hidden rounded bg-slate-100"><div className="h-full rounded bg-slate-700" style={{ width: `${(r.precision ?? 0) * 100}%` }} /></div>
                <span className="font-semibold">{pct(r.precision)}</span>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
