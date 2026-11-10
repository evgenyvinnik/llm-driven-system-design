import { ErrorClassText, OutcomeText } from '@/components/shared/Chips'
import { ms, time } from '@/lib/format'
import type { Attempt } from '@/types'

const TRIGGER_LABEL: Record<Attempt['trigger'], string> = {
  initial: 'first attempt',
  retry: 'retry',
  replay: 'manual replay',
  recovered: 'taken over from a lost worker',
}

function waitBefore(prev: Attempt | undefined): string | null {
  if (!prev?.nextAttemptAt) return null
  const planned = new Date(prev.nextAttemptAt).getTime() - (new Date(prev.startedAt).getTime() + (prev.latencyMs ?? 0))
  return planned > 0 ? `backoff ${ms(Math.round(planned))}` : null
}

/** Every attempt of one delivery, oldest first, with the planned backoff between them. */
export function AttemptTimeline({ attempts }: { attempts: Attempt[] }) {
  if (attempts.length === 0) return <p className="px-4 py-6 text-sm text-slate-500">Not attempted yet.</p>
  return (
    <ol className="divide-y divide-slate-100" aria-label="Attempts">
      {attempts.map((a, i) => {
        const wait = waitBefore(attempts[i - 1])
        return (
          <li key={a.id} className="px-4 py-3">
            {wait && <div className="mb-2 text-[11px] uppercase tracking-wide text-slate-400">↓ {wait} (full jitter)</div>}
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className="text-sm font-semibold text-slate-900">Attempt {a.attemptNo}</span>
              <span className="text-xs text-slate-500">{TRIGGER_LABEL[a.trigger]}</span>
              <span className="num text-xs text-slate-500">{time(a.startedAt)}</span>
              <span className="num font-mono text-sm text-slate-800">{a.statusCode ?? '—'}</span>
              <span className="text-sm"><ErrorClassText errorClass={a.errorClass} /></span>
              <span className="num text-xs text-slate-600">{ms(a.latencyMs)}</span>
              <OutcomeText outcome={a.outcome} />
              {a.nextAttemptAt && a.outcome === 'retry' && <span className="text-xs text-slate-500">next at {time(a.nextAttemptAt)}</span>}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 text-[11px] text-slate-400">
              {a.workerId && <span>{a.workerId}</span>}
              {a.resolvedIp && <span>connected to {a.resolvedIp}</span>}
              {a.signaturesSent > 1 && <span>{a.signaturesSent} signatures (rotation overlap)</span>}
            </div>
            {a.errorMessage && <p className="mt-1 text-xs text-slate-600">{a.errorMessage}</p>}
            {a.responseBody && <pre className="mt-1 max-h-24 overflow-auto rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-600">{a.responseBody}</pre>}
          </li>
        )
      })}
    </ol>
  )
}
