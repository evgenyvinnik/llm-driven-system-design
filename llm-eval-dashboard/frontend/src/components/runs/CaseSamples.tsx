import { useState } from 'react'
import { PassChip, TaskChip } from '@/components/shared/Chips'
import { ms } from '@/lib/format'
import type { CaseView, RunScorer } from '@/types'
import { AttemptList } from './AttemptList'

/** Every sample of one case: output, scores per scorer version, error, usage, attempts. */
export function CaseSamples({ runId, c, scorers }: { runId: string; c: CaseView; scorers: RunScorer[] }) {
  const [openAttempts, setOpenAttempts] = useState<string | null>(null)
  return (
    <div className="space-y-3 bg-slate-50 px-4 py-3">
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <div className="label">Input</div>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-white p-2 font-mono text-[11px] text-slate-700">{JSON.stringify(c.input, null, 2)}</pre>
        </div>
        <div>
          <div className="label">Reference</div>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-white p-2 font-mono text-[11px] text-slate-700">{c.reference}</pre>
        </div>
      </div>
      <div className="space-y-2">
        {c.samples.map((s) => (
          <div key={s.id} className="rounded border border-slate-200 bg-white p-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-semibold text-slate-700">sample {s.sampleIndex}</span>
              <TaskChip status={s.status} />
              <span className="text-slate-500">
                {s.attempts} attempt{s.attempts === 1 ? '' : 's'}
              </span>
              {s.status === 'succeeded' && (
                <span className="text-slate-500">
                  {s.inputTokens}→{s.outputTokens} tok · queue {ms(s.queueMs)} · ttft {ms(s.ttftMs)} · gen {ms(s.generationMs)}
                </span>
              )}
              <button type="button" className="ml-auto text-accent-700 hover:underline" onClick={() => setOpenAttempts(openAttempts === s.id ? null : s.id)}>
                attempts
              </button>
            </div>
            {s.errorCode && <div className="mt-1 text-xs text-rose-700">{s.errorCode}: {s.errorMessage}</div>}
            {s.output !== null && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-slate-800">{s.output}</pre>}
            {s.status === 'succeeded' && (
              <div className="mt-1 flex flex-wrap gap-3 text-[11px]">
                {scorers.map((sc) => {
                  const cell = s.scores[sc.scorerVersionId]
                  return (
                    <span key={sc.scorerVersionId} className="flex items-center gap-1" title={cell?.rationale ?? ''}>
                      <span className="text-slate-500">
                        {sc.name} v{sc.version}:
                      </span>
                      {cell?.status === 'scored' ? <PassChip passed={cell.passed} score={cell.score} /> : <span className="text-slate-400">{cell?.status ?? 'none'}</span>}
                      {cell?.confidence !== null && cell?.confidence !== undefined && <span className="text-slate-400">conf {cell.confidence.toFixed(2)}</span>}
                    </span>
                  )
                })}
                {s.annotation && <span className="text-violet-700">human: {s.annotation.label}{s.annotation.note ? ` (${s.annotation.note})` : ''}</span>}
              </div>
            )}
            {openAttempts === s.id && (
              <div className="mt-2 border-t border-slate-100 pt-2">
                <AttemptList runId={runId} caseResultId={s.id} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
