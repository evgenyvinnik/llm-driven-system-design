import { Fragment, useMemo, useState } from 'react'
import { ChevronDownIcon, ChevronRightIcon } from '@/components/icons'
import { Tag } from '@/components/shared/Chips'
import { preview, score } from '@/lib/format'
import type { CaseView, RunScorer } from '@/types'
import { CaseSamples } from './CaseSamples'

type Filter = 'all' | 'errored' | 'flaky' | 'failing'

function SampleDots({ c, svId }: { c: CaseView; svId: string }) {
  return (
    <div className="flex gap-0.5">
      {c.samples.map((s) => {
        const cell = s.scores[svId]
        const tone =
          s.status === 'errored' ? 'bg-rose-500' : s.status === 'cancelled' ? 'bg-amber-300' : s.status !== 'succeeded' ? 'bg-slate-200' : cell?.status !== 'scored' ? 'bg-slate-300' : cell.passed ? 'bg-emerald-500' : (cell.score ?? 0) > 0 ? 'bg-amber-400' : 'bg-slate-500'
        return <span key={s.id} className={`h-3 w-2 rounded-sm ${tone}`} title={`sample ${s.sampleIndex}: ${s.status}${cell?.status === 'scored' ? `, score ${cell.score}` : ''}`} />
      })}
    </div>
  )
}

export function CaseTable({ runId, cases, scorers, svId }: { runId: string; cases: CaseView[]; scorers: RunScorer[]; svId: string }) {
  const [filter, setFilter] = useState<Filter>('all')
  const [open, setOpen] = useState<string | null>(null)
  const rows = useMemo(() => {
    const list = cases.filter((c) => {
      const st = c.stats[svId]
      if (filter === 'errored') return c.samples.some((s) => s.status === 'errored')
      if (filter === 'flaky') return st?.flaky
      if (filter === 'failing') return st?.mean !== null && st?.mean !== undefined && st.mean < 1
      return true
    })
    return filter === 'flaky' ? [...list].sort((a, b) => (b.stats[svId]?.variance ?? 0) - (a.stats[svId]?.variance ?? 0)) : list
  }, [cases, filter, svId])
  const count = (f: Filter) => (f === 'all' ? cases.length : cases.filter((c) => (f === 'errored' ? c.samples.some((s) => s.status === 'errored') : f === 'flaky' ? c.stats[svId]?.flaky : (c.stats[svId]?.mean ?? 1) < 1)).length)

  return (
    <div className="card overflow-x-auto">
      <div className="flex gap-1 border-b border-slate-200 px-3 py-2" role="tablist">
        {(['all', 'errored', 'flaky', 'failing'] as Filter[]).map((f) => (
          <button key={f} type="button" role="tab" aria-selected={filter === f} className={`rounded-md px-2.5 py-1 text-xs font-medium ${filter === f ? 'bg-accent-50 text-accent-700' : 'text-slate-600 hover:bg-slate-100'}`} onClick={() => setFilter(f)}>
            {f === 'flaky' ? 'flaky (samples disagree)' : f} · {count(f)}
          </button>
        ))}
      </div>
      <table className="w-full" aria-label="Cases">
        <thead className="border-b border-slate-200 bg-slate-50">
          <tr>
            <th className="th w-8" />
            <th className="th">Case</th>
            <th className="th">Input</th>
            <th className="th">Reference</th>
            <th className="th">Samples</th>
            <th className="th">Case mean</th>
            <th className="th">Variance</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((c) => {
            const st = c.stats[svId]
            const errored = c.samples.filter((s) => s.status === 'errored').length
            return (
              <Fragment key={c.caseId}>
                <tr className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(open === c.caseId ? null : c.caseId)}>
                  <td className="td text-slate-400">{open === c.caseId ? <ChevronDownIcon /> : <ChevronRightIcon />}</td>
                  <td className="td">
                    <div className="font-mono text-xs font-semibold">{c.caseKey}</div>
                    <div className="mt-0.5 flex flex-wrap gap-1">{c.tags.slice(0, 3).map((t) => <Tag key={t}>{t}</Tag>)}</div>
                  </td>
                  <td className="td max-w-xs text-xs text-slate-600">{preview(Object.values(c.input)[0], 80)}</td>
                  <td className="td max-w-[12rem] font-mono text-[11px] text-slate-600">{preview(c.reference, 40)}</td>
                  <td className="td">
                    <SampleDots c={c} svId={svId} />
                  </td>
                  <td className="td num">
                    {st?.mean !== null && st?.mean !== undefined ? score(st.mean) : <span className="text-xs text-rose-700">{errored > 0 ? `errored ×${errored}` : '—'}</span>}
                    {errored > 0 && st?.mean !== null && st?.mean !== undefined && <div className="text-[11px] text-rose-700">{errored} errored</div>}
                  </td>
                  <td className="td num text-xs">{st?.flaky ? <span className="font-medium text-amber-700">{st.variance.toFixed(3)} flaky</span> : <span className="text-slate-400">{st ? st.variance.toFixed(3) : '—'}</span>}</td>
                </tr>
                {open === c.caseId && (
                  <tr>
                    <td colSpan={7} className="p-0">
                      <CaseSamples runId={runId} c={c} scorers={scorers} />
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
