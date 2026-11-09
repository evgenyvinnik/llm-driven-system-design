import { Chip, ToneIcon } from '@/components/shared/Chips'
import { ms } from '@/lib/format'
import type { HostReview, Intent, Run } from '@/types'

export function UsageCard({ run }: { run: Run | undefined }) {
  if (!run) return null
  const u = run.usage
  const rows: [string, string][] = [
    ['Status', `${run.status}${run.attempt > 1 ? `, attempt ${run.attempt}` : ''}`],
    ['Tokens', `${u.inputTokens.toLocaleString()} in, ${u.outputTokens.toLocaleString()} out`],
    ['Queue time', ms(u.queueMs)],
    ['Time to first token', ms(u.ttftMs)],
    ['Generation time', ms(u.generationMs)],
    ['Model calls', String(u.modelCalls)],
    ['Diff hash', run.diffHash?.slice(0, 12) ?? '—'],
    ['Prompt hash', run.promptHash?.slice(0, 12) ?? '—'],
  ]
  return (
    <section aria-label="Run usage" className="card p-4">
      <h2 className="panel-title mb-2">Review run</h2>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-slate-500">{k}</dt>
            <dd className="num text-right text-slate-800">{v}</dd>
          </div>
        ))}
      </dl>
      {run.cancelReason && <p className="mt-2 text-xs text-amber-800">Cancelled: {run.cancelReason.replace(/_/g, ' ')}{run.supersededBySha ? ` by ${run.supersededBySha.slice(0, 7)}` : ''}</p>}
    </section>
  )
}

export function HostPanel({ reviews, blockers, intents }: { reviews: HostReview[] | null; blockers: string[] | null; intents: Intent[] }) {
  const pending = intents.filter((i) => i.status === 'pending' || i.status === 'running')
  return (
    <section aria-label="Host state" className="card p-4">
      <h2 className="panel-title mb-2">At the host</h2>
      {blockers && (
        <div className="mb-2 flex items-start gap-1.5 text-sm">
          <span className="mt-0.5"><ToneIcon ok={blockers.length === 0} /></span>
          <span className="text-slate-700">{blockers.length === 0 ? 'Mergeable' : `Blocked: ${blockers.join('; ')}`}</span>
        </div>
      )}
      {reviews && reviews.filter((r) => r.state !== 'COMMENTED').length > 0 ? (
        <ul className="space-y-1 text-sm">
          {reviews.filter((r) => r.state !== 'COMMENTED').map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-1.5">
              <Chip tone={r.dismissed ? 'mute' : r.state === 'APPROVED' ? 'good' : 'bad'}>{r.state.toLowerCase().replace('_', ' ')}{r.dismissed ? ', dismissed' : ''}</Chip>
              <span className="text-slate-600">{r.user.login}</span>
              <code className="code">{r.commit_id.slice(0, 7)}</code>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-slate-500">No approving or blocking reviews.</p>}
      {pending.length > 0 && <p className="mt-2 text-xs text-slate-500">{pending.length} post(s) queued.</p>}
    </section>
  )
}
