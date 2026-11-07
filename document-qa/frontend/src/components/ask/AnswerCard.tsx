import { Link } from '@tanstack/react-router'
import { LockIcon, StopIcon } from '@/components/icons'
import { ago } from '@/lib/format'
import { useAskStore } from '@/stores/ask-store'
import type { Run } from '@/types'
import { AnswerText } from './AnswerText'
import { RetrievalLine, StatusLine, UsageLine } from './RunMeta'

export function AnswerCard({ run }: { run: Run }) {
  const stop = useAskStore((s) => s.stop)
  const live = run.status === 'queued' || run.status === 'running'
  return (
    <li className="space-y-2">
      <div className="flex justify-end">
        <div className="max-w-2xl rounded-lg bg-accent-600 px-3 py-2 text-sm text-white">{run.question}</div>
      </div>
      <div className="card space-y-2 px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          {/* Announced to screen readers when the status changes (completed, cancelled, failed). */}
          <div role="status" aria-live="polite">
            <StatusLine run={run} />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-slate-400">{ago(run.createdAt)}</span>
            {live && (
              <button type="button" className="btn-secondary !py-1 text-xs" onClick={() => void stop(run.id)}>
                <StopIcon className="h-3 w-3" /> Stop
              </button>
            )}
          </div>
        </div>
        <RetrievalLine run={run} />
        {run.redacted ? (
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <LockIcon className="h-4 w-4" /> {run.redacted}
          </p>
        ) : run.outputText || live ? (
          <AnswerText text={run.outputText} citations={run.citations} sources={run.sources} streaming={live} />
        ) : null}
        {!run.redacted && run.sources.length > 0 && (
          <ol className="space-y-0.5 border-t border-slate-100 pt-2 text-xs text-slate-500" aria-label="Sources">
            {run.sources.map((s) => (
              <li key={s.n}>
                <span className="font-semibold text-slate-600">[{s.n}]</span>{' '}
                <Link
                  to="/documents/$documentId"
                  params={{ documentId: s.documentId }}
                  search={{ version: s.versionId, start: s.charStart, end: s.charEnd }}
                  className="text-accent-700 hover:underline"
                >
                  {s.title}
                </Link>{' '}
                v{s.versionNo} · chunk {s.ordinal}
                {s.heading ? ` · ${s.heading}` : ''} · chars {s.charStart}–{s.charEnd}
              </li>
            ))}
          </ol>
        )}
        <UsageLine run={run} />
      </div>
    </li>
  )
}
