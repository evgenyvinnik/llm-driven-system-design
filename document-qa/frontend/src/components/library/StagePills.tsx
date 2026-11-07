/** Per-stage pills for a document's latest version: extract → chunk → embed → index. */
import { progressText } from '@/lib/format'
import type { StageState } from '@/types'

const STAGES = ['extract', 'chunk', 'embed', 'index']

const STYLE: Record<string, string> = {
  succeeded: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  running: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  pending: 'bg-sky-50 text-sky-700 ring-sky-200',
  poisoned: 'bg-rose-50 text-rose-800 ring-rose-200',
  cancelled: 'bg-slate-100 text-slate-500 ring-slate-200',
  waiting: 'bg-white text-slate-400 ring-slate-200',
}

const MARK: Record<string, string> = { succeeded: '✓', running: '…', pending: '·', poisoned: '✕', cancelled: '–', waiting: '' }

export function StagePills({ stages }: { stages: StageState[] }) {
  return (
    <div className="flex flex-wrap gap-1" aria-label="Pipeline stages">
      {STAGES.map((name) => {
        const s = stages.find((x) => x.stage === name)
        const status = s?.status ?? 'waiting'
        const prog = s && status !== 'succeeded' ? progressText(s.progress) : null
        const waiting = s && typeof s.progress.waiting === 'string' ? s.progress.waiting : null
        const hint = [s?.lastError, waiting, s ? `attempt ${s.attempts}/${s.maxAttempts}` : 'not started'].filter(Boolean).join(' · ')
        return (
          <span key={name} className={`chip ring-1 ring-inset ${STYLE[status] ?? STYLE.waiting}`} title={`${name}: ${status}${hint ? ` — ${hint}` : ''}`}>
            {name} {MARK[status]}
            {prog && <span className="num font-normal">{prog}</span>}
            {s && s.attempts > 1 && <span className="font-normal">×{s.attempts}</span>}
          </span>
        )
      })}
    </div>
  )
}
