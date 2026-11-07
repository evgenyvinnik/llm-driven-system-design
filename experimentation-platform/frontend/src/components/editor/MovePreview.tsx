/**
 * "This change moves N% of users, M% of them out of treatment", computed with
 * the same allocation code the server runs on save, next to what the two
 * naive strategies would have done with the same weights.
 */
import { allocateContiguous, compareAllocations, expectedRehashChange, type Allocation, type MoveSummary } from '@exp/core'
import { ShuffleIcon } from '@/components/icons'
import { pct, pctBuckets } from '@/lib/format'

function leavingShare(move: MoveSummary, keys: string[]): number {
  const before = keys.reduce((s, k) => s + (move.leaving[k]?.before ?? 0), 0)
  const left = keys.reduce((s, k) => s + (move.leaving[k]?.left ?? 0), 0)
  return before > 0 ? left / before : 0
}

export function MovePreview(props: { current: Allocation; proposed: Allocation; before: Record<string, number>; after: Record<string, number>; order: string[]; control: string }) {
  const treatments = props.order.filter((v) => v !== props.control)
  const stable = compareAllocations(props.current, props.proposed)
  const naive = compareAllocations(allocateContiguous(props.before, props.order), allocateContiguous(props.after, props.order))
  const rehash = expectedRehashChange(props.before, props.after)
  const rehashLeaving = treatments.reduce((s, k) => s + (props.before[k] ?? 0) * (rehash.leaving[k] ?? 0), 0) / Math.max(1, treatments.reduce((s, k) => s + (props.before[k] ?? 0), 0))
  const treatmentLabel = treatments.length === 1 ? treatments[0] : 'non-control'

  return (
    <div className="space-y-3 rounded-md border border-accent-100 bg-accent-50/50 p-3 text-sm" data-testid="move-preview">
      <div className="flex items-start gap-2">
        <ShuffleIcon className="mt-0.5 h-4 w-4 text-accent-600" />
        <div>
          <p className="font-medium text-slate-800">
            This change moves <span className="num">{pctBuckets(stable.changed)}</span> of units
            {stable.changed > 0 && <>, {pct(leavingShare(stable, treatments), 1)} of current {treatmentLabel} units out of {treatmentLabel}</>}.
          </p>
          <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
            {stable.transitions.map((t) => (
              <li key={`${t.from}-${t.to}`} className="num">
                {t.from ?? 'not enrolled'} → {t.to ?? 'not enrolled'}: {pctBuckets(t.buckets)}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <table className="w-full text-xs" aria-label="Allocation strategies">
        <thead>
          <tr className="text-left text-slate-500">
            <th className="py-1 font-medium">Strategy</th>
            <th className="py-1 font-medium">Units that change variant</th>
            <th className="py-1 font-medium">{treatmentLabel} units sent elsewhere</th>
          </tr>
        </thead>
        <tbody className="num">
          <tr className="font-semibold text-emerald-800">
            <td className="py-0.5">Stable ranges (this platform)</td>
            <td>{pctBuckets(stable.switched + stable.unenrolled)}</td>
            <td>{pct(leavingShare(stable, treatments), 1)}</td>
          </tr>
          <tr className="text-slate-600">
            <td className="py-0.5">Naive: re-partition from bucket 0</td>
            <td>{pctBuckets(naive.switched + naive.unenrolled)}</td>
            <td>{pct(leavingShare(naive, treatments), 1)}</td>
          </tr>
          <tr className="text-slate-600">
            <td className="py-0.5">Naive: re-hash (new salt / version in hash)</td>
            <td>~{pct(rehash.changed, 1)} (any change)</td>
            <td>~{pct(rehashLeaving, 1)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
