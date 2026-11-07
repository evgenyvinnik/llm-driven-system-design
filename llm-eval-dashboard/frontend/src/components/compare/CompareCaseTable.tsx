import { Fragment, useState } from 'react'
import { ChevronDownIcon, ChevronRightIcon } from '@/components/icons'
import { PassChip, Tag } from '@/components/shared/Chips'
import { preview, score, signed } from '@/lib/format'
import type { CompareCase, CompareSample } from '@/types'

function Side({ title, samples }: { title: string; samples: CompareSample[] }) {
  return (
    <div className="space-y-1.5">
      <div className="label">{title}</div>
      {samples.map((s) => (
        <div key={s.sampleIndex} className="rounded border border-slate-200 bg-white p-2">
          <div className="mb-1 flex items-center gap-2 text-[11px] text-slate-500">
            sample {s.sampleIndex} {s.status === 'succeeded' ? <PassChip passed={s.passed} score={s.score} /> : <span className="text-rose-700">{s.status}{s.errorCode ? `: ${s.errorCode}` : ''}</span>}
          </div>
          {s.output && <pre className="max-h-28 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-slate-800">{s.output}</pre>}
        </div>
      ))}
    </div>
  )
}

/** Per-case means side by side, largest regressions first, with outputs on drill-down. */
export function CompareCaseTable({ cases }: { cases: CompareCase[] }) {
  const [open, setOpen] = useState<string | null>(null)
  return (
    <div className="card overflow-x-auto">
      <table className="w-full" aria-label="Case differences">
        <thead className="border-b border-slate-200 bg-slate-50">
          <tr>
            <th className="th w-8" />
            <th className="th">Case</th>
            <th className="th">Input</th>
            <th className="th">Mean A</th>
            <th className="th">Mean B</th>
            <th className="th">Δ (B − A)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {cases.map((c) => (
            <Fragment key={c.caseKey}>
              <tr className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(open === c.caseKey ? null : c.caseKey)}>
                <td className="td text-slate-400">{open === c.caseKey ? <ChevronDownIcon /> : <ChevronRightIcon />}</td>
                <td className="td">
                  <div className="font-mono text-xs font-semibold">{c.caseKey}</div>
                  <div className="mt-0.5 flex gap-1">{c.tags.slice(0, 2).map((t) => <Tag key={t}>{t}</Tag>)}</div>
                </td>
                <td className="td max-w-sm text-xs text-slate-600">{preview(Object.values(c.input)[0], 90)}</td>
                <td className="td num">{score(c.meanA)}</td>
                <td className="td num">{score(c.meanB)}</td>
                <td className="td num">
                  {c.excluded ? (
                    <span className="text-xs text-slate-500">excluded: {c.excluded}</span>
                  ) : (
                    <span className={`font-semibold ${(c.diff ?? 0) < 0 ? 'text-rose-700' : (c.diff ?? 0) > 0 ? 'text-emerald-700' : 'text-slate-400'}`}>{signed(c.diff)}</span>
                  )}
                </td>
              </tr>
              {open === c.caseKey && (
                <tr>
                  <td colSpan={6} className="bg-slate-50 px-4 py-3">
                    <div className="mb-2 text-xs text-slate-600">
                      Reference: <span className="font-mono">{c.reference}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <Side title="A" samples={c.samplesA} />
                      <Side title="B" samples={c.samplesB} />
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}
