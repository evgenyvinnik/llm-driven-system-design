import { Link } from '@tanstack/react-router'
import { ProgressBar } from '@/components/shared/ProgressBar'
import { RunStatusChip } from '@/components/shared/Chips'
import { ago, score } from '@/lib/format'
import type { RunListItem } from '@/types'

/** Every aggregate is shown with its interval and the errored count next to it. */
export function RunsTable({ runs }: { runs: RunListItem[] }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full" aria-label="Runs">
        <thead className="border-b border-slate-200 bg-slate-50">
          <tr>
            <th className="th">Run</th>
            <th className="th">Status</th>
            <th className="th">Progress</th>
            <th className="th">Primary score (95% CI)</th>
            <th className="th">Pins</th>
            <th className="th">Created</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {runs.map((r) => {
            const a = r.primary?.aggregate
            return (
              <tr key={r.id} className="hover:bg-slate-50">
                <td className="td">
                  <Link to="/runs/$runId" params={{ runId: r.id }} className="font-medium text-accent-700 hover:underline">
                    {r.name}
                  </Link>
                  <div className="font-mono text-[11px] text-slate-400">{r.id}</div>
                </td>
                <td className="td">
                  <RunStatusChip status={r.status} errored={r.progress.errored} />
                </td>
                <td className="td">
                  <ProgressBar progress={r.progress} total={r.totalTasks} />
                </td>
                <td className="td">
                  {a && a.mean !== null ? (
                    <div>
                      <span className="num font-semibold text-slate-900">{score(a.mean)}</span>
                      <span className="num text-slate-500"> ± {a.ciHalfWidth !== null ? a.ciHalfWidth.toFixed(3) : '—'}</span>
                      <div className="text-[11px] text-slate-500">
                        {r.primary?.name} v{r.primary?.version} · n={a.scoredCases} cases
                        {a.erroredTasks > 0 && <span className="text-rose-700"> · {a.erroredTasks} errored excluded</span>}
                        {a.cancelledTasks > 0 && <span className="text-amber-700"> · {a.cancelledTasks} cancelled</span>}
                      </div>
                    </div>
                  ) : (
                    <span className="text-xs text-slate-400">{r.status === 'failed' ? `no successful cases (${r.progress.errored} errored)` : 'no scores yet'}</span>
                  )}
                </td>
                <td className="td text-xs text-slate-600">
                  <div>
                    {r.dataset.name} <b>v{r.dataset.version}</b> · {r.prompt.name} <b>v{r.prompt.version}</b>
                  </div>
                  <div className="text-slate-400">
                    {r.modelConfig.name} · ×{r.samplesPerCase} samples
                  </div>
                </td>
                <td className="td text-xs text-slate-500">
                  {ago(r.createdAt)}
                  <div className="text-slate-400">{r.createdBy}</div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
