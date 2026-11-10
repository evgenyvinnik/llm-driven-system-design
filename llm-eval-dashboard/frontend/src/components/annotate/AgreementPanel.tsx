import { pct } from '@/lib/format'
import type { AgreementStats, AnnotationQueue } from '@/types'

function Cell({ a }: { a: AgreementStats }) {
  if (a.n === 0) return <td className="td text-xs text-slate-400">no labels</td>
  return (
    <td className="td num text-sm">
      {pct(a.rate)} <span className="text-xs text-slate-500">({a.agree}/{a.n}, κ {a.kappa === null ? '—' : a.kappa.toFixed(2)})</span>
    </td>
  )
}

/** Judge vs human, split: items chosen because the judge was unsure are biased toward disagreement. */
export function AgreementPanel({ queue }: { queue: AnnotationQueue }) {
  return (
    <div className="card overflow-x-auto p-4" aria-label="Agreement">
      <div className="mb-2 flex items-center justify-between">
        <div className="panel-title">Judge vs human agreement</div>
        <div className="text-xs text-slate-500">
          {queue.labeled} of {queue.total} queue items labeled
        </div>
      </div>
      {queue.agreement.length === 0 ? (
        <p className="text-sm text-slate-500">This run has no model-graded scorer; labels still feed any human scorer on the run.</p>
      ) : (
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">Judge version</th>
              <th className="th">All labeled</th>
              <th className="th">Random spot checks</th>
              <th className="th">Low confidence / disagreeing</th>
            </tr>
          </thead>
          <tbody>
            {queue.agreement.map((r) => (
              <tr key={r.scorerVersionId}>
                <td className="td text-sm font-medium">
                  {r.name} v{r.version}
                </td>
                <Cell a={r.overall} />
                <Cell a={r.spotCheck} />
                <Cell a={r.queue} />
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
