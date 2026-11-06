import { SagaStateBadge, SeverityBadge } from '@/components/shared/Badges'
import { fmtTime, label } from '@/lib/format'
import type { ExceptionRow, SagaRow } from '@/types'

export function CarExceptions({ exceptions }: { exceptions: ExceptionRow[] }) {
  if (exceptions.length === 0) return <p className="text-sm text-slate-500">No exceptions for this car.</p>
  return (
    <ul className="space-y-2">
      {exceptions.map((x) => (
        <li key={x.exception_id} className="rounded-md border border-slate-200 p-2 text-sm">
          <div className="flex items-center gap-2">
            <SeverityBadge severity={x.severity} />
            <span className="font-medium">{label(x.type)}</span>
            <span className={`chip ${x.status === 'open' ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-600'}`}>{x.status}</span>
          </div>
          <p className="mt-1 text-slate-600">{x.summary}</p>
          <p className="text-xs text-slate-400">
            opened {fmtTime(x.opened_at)}
            {x.resolution ? ` · ${x.resolution}` : ''}
          </p>
        </li>
      ))}
    </ul>
  )
}

/** The replanning sagas for this car: one per missed connection or cancelled train, with their steps. */
export function CarSagas({ sagas }: { sagas: SagaRow[] }) {
  if (sagas.length === 0) return <p className="text-sm text-slate-500">No replans for this car.</p>
  return (
    <ul className="space-y-2">
      {sagas.map((s) => (
        <li key={s.saga_id} className="rounded-md border border-slate-200 p-2 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-xs font-semibold">{s.saga_id}</span>
            <SagaStateBadge state={s.state} />
          </div>
          <p className="mt-1 text-slate-600">
            {label(s.trigger_type)} at {s.yard_id}: {s.missed_run_id} → {s.chosen_run_id ?? '…'}
            {s.parent_saga_id ? ` (attempt ${s.attempt}, after ${s.parent_saga_id})` : ''}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {s.steps.map((st, i) => (
              <span key={i} className="chip bg-slate-100 text-slate-600" title={JSON.stringify(st)}>
                {st.step}→{label(st.to)}
              </span>
            ))}
          </div>
        </li>
      ))}
    </ul>
  )
}
