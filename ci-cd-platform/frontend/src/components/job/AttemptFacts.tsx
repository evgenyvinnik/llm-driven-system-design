import { KeyIcon } from '@/components/icons'
import { StatusChip } from '@/components/shared/StatusChip'
import { clock, duration, triggerLabel } from '@/lib/format'
import type { Attempt } from '@/types'

export function AttemptFacts({ attempt }: { attempt: Attempt }) {
  return (
    <div className="space-y-3 p-4 text-sm">
      <dl className="grid gap-x-6 gap-y-2 text-xs md:grid-cols-4">
        <div>
          <dt className="label !mb-0.5">Why this attempt</dt>
          <dd>{triggerLabel(attempt.trigger)}{attempt.triggeredBy ? `, by ${attempt.triggeredBy}` : ''}</dd>
        </div>
        <div>
          <dt className="label !mb-0.5">Runner</dt>
          <dd>{attempt.runnerName ?? '—'}</dd>
        </div>
        <div>
          <dt className="label !mb-0.5">Fencing token</dt>
          <dd className="num font-mono">{attempt.fencingToken ?? '—'}</dd>
        </div>
        <div>
          <dt className="label !mb-0.5">Ran</dt>
          <dd className="num">
            {clock(attempt.startedAt)}, {duration(attempt.startedAt, attempt.finishedAt)}
          </dd>
        </div>
      </dl>
      {attempt.statusReason && <p className="text-xs text-slate-600">{attempt.statusReason}</p>}
      {attempt.confirmedNonIdempotent && <p className="text-xs font-medium text-amber-800">{attempt.triggeredBy ?? 'A maintainer'} explicitly confirmed running the non-idempotent steps again.</p>}
      {attempt.approval && (
        <p className="text-xs text-slate-600">
          Environment {attempt.approval.decision} by {attempt.approval.by}
          {attempt.approval.comment ? `: "${attempt.approval.comment}"` : ''}
        </p>
      )}
      {attempt.resolution && (
        <p className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-700" aria-label="Resolution">
          Outcome decided by {attempt.resolution.by}: <strong>{attempt.resolution.decision}</strong>
          {attempt.resolution.note ? `. "${attempt.resolution.note}"` : ''}
        </p>
      )}
      {attempt.lateReport && (
        <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">
          Rejected report from the stale runner: <strong>{attempt.lateReport.conclusion}</strong>
          {attempt.lateReport.reason ? ` (${attempt.lateReport.reason})` : ''}. Kept as evidence, not applied.
        </p>
      )}
      {(attempt.secretsReleased.length > 0 || attempt.secretsWithheld.length > 0) && (
        <div className="space-y-1 text-xs" aria-label="Secrets for this attempt">
          {attempt.secretsReleased.map((name) => (
            <div key={name} className="flex items-center gap-1.5 text-emerald-800">
              <KeyIcon className="h-3.5 w-3.5" /> <span className="font-mono">{name}</span> released at claim
            </div>
          ))}
          {attempt.secretsWithheld.map((w) => (
            <div key={w.name} className="flex items-center gap-1.5 text-orange-800">
              <KeyIcon className="h-3.5 w-3.5" /> <span className="font-mono">{w.name}</span> withheld: {w.reason}
            </div>
          ))}
        </div>
      )}
      {attempt.steps.length > 0 && (
        <table className="w-full" aria-label="Steps">
          <thead className="border-b border-slate-100">
            <tr>
              <th className="th !pl-0">Step</th>
              <th className="th">Status</th>
              <th className="th">Exit</th>
              <th className="th">Duration</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {attempt.steps.map((s) => (
              <tr key={s.index}>
                <td className="td !pl-0">
                  {s.index + 1}. {s.name}
                  {!s.idempotent && <span className="chip ml-1.5 bg-amber-100 text-amber-800">non-idempotent</span>}
                </td>
                <td className="td">
                  <StatusChip status={s.status} />
                </td>
                <td className="td num text-xs">{s.exitCode ?? '—'}</td>
                <td className="td num text-xs">{duration(s.startedAt, s.finishedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
