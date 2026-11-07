import { useEffect, useState } from 'react'
import { ms } from '@/lib/format'
import { api } from '@/services/api'
import type { Attempt } from '@/types'

const TONE: Record<string, string> = {
  succeeded: 'text-emerald-700',
  retry_scheduled: 'text-amber-700',
  errored: 'text-rose-700',
  lease_expired: 'text-violet-700',
  superseded: 'text-slate-500',
  cancelled: 'text-amber-700',
  in_progress: 'text-sky-700',
}

export function AttemptList({ runId, caseResultId }: { runId: string; caseResultId: string }) {
  const [attempts, setAttempts] = useState<Attempt[] | null>(null)
  useEffect(() => {
    void api.attempts(runId, caseResultId).then((r) => setAttempts(r.attempts))
  }, [runId, caseResultId])
  if (!attempts) return <div className="text-xs text-slate-400">Loading attempts…</div>
  return (
    <ol className="space-y-0.5 text-[11px]" aria-label="Attempts">
      {attempts.map((a) => (
        <li key={a.attempt} className="font-mono">
          #{a.attempt} <span className={TONE[a.outcome] ?? ''}>{a.outcome}</span>
          {a.errorCode && ` · ${a.errorCode}`}
          {a.httpStatus && ` (${a.httpStatus})`}
          {a.delayMs !== null && ` · retry in ${ms(a.delayMs)}`} · {a.workerId}
        </li>
      ))}
    </ol>
  )
}
