import { AlertIcon, CheckIcon } from '@/components/icons'
import { pValue, pct } from '@/lib/format'
import type { Analysis } from '@/types'

/**
 * Sample ratio mismatch: the exposed split is very unlikely under the
 * configured weights. Comparing with the assignment split says where to look.
 */
export function SrmBanner({ exposed, assigned }: { exposed: Analysis; assigned: Analysis }) {
  const srm = exposed.srm
  if (!srm) return <p className="rounded-md bg-slate-100 px-3 py-2 text-xs text-slate-600">Not enough exposures yet for a sample ratio check.</p>
  const split = (a: Analysis, field: 'observedShare' | 'expectedShare') => a.arms.map((x) => pct(x[field], 1)).join(' / ')
  if (!srm.flagged) {
    return (
      <p className="flex items-center gap-2 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800" data-testid="srm-ok">
        <CheckIcon className="h-4 w-4" /> Sample ratio OK: exposed split {split(exposed, 'observedShare')} vs expected {split(exposed, 'expectedShare')} (χ² = {srm.chi2.toFixed(2)}, p = {pValue(srm.pValue)}).
      </p>
    )
  }
  const assignedOk = assigned.srm && !assigned.srm.flagged
  return (
    <div className="rounded-lg border border-rose-300 bg-rose-50 p-4" role="alert" data-testid="srm-warning">
      <div className="flex items-center gap-2 text-sm font-semibold text-rose-800">
        <AlertIcon className="h-5 w-5" /> Sample ratio mismatch: do not trust these results
      </div>
      <p className="mt-1 text-sm text-rose-900">
        Exposed split {split(exposed, 'observedShare')}, expected {split(exposed, 'expectedShare')} (χ² = {srm.chi2.toFixed(1)}, df = {srm.df}, p = {pValue(srm.pValue)} &lt; {srm.threshold}).
      </p>
      <p className="mt-1 text-xs text-rose-900/80">
        {assignedOk
          ? `Assignments are balanced (p = ${pValue(assigned.srm!.pValue)}), so bucketing works and the loss is in exposure logging: one variant fails to log some of its exposures (a slow image, a crash, a redirect before mount).`
          : 'Assignments are unbalanced too: look at bucketing, targeting or a bot filter before the exposure path.'}
      </p>
    </div>
  )
}
