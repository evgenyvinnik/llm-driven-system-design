import { AlertIcon, ShieldCheckIcon } from '@/components/icons'
import { OutcomeChip, Sha } from '@/components/shared/Chips'
import { humanize } from '@/lib/format'
import type { Decision, ModelOutput } from '@/types'

/** The point of the whole system, stated plainly: what the model said, and what happened anyway. */
export function DecisionBanner({ decision, model }: { decision: Decision; model: ModelOutput | null }) {
  const overruled = decision.modelOverruled
  const tone = overruled || decision.outcome === 'escalated' ? 'border-amber-300 bg-amber-50' : decision.outcome.endsWith('approved') ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 bg-white'
  return (
    <section aria-label="Decision" className={`rounded-lg border p-4 ${tone}`}>
      <div className="flex flex-wrap items-center gap-2">
        <OutcomeChip outcome={decision.outcome} invalidated={decision.state !== 'active'} />
        <span className="text-sm text-slate-600">for <Sha sha={decision.headSha} /> in {humanize(decision.mode)} mode, decided by {decision.actor}</span>
      </div>
      {overruled && model && (
        <p className="mt-2 flex items-start gap-1.5 text-sm font-medium text-amber-900">
          <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
          The model said {model.verdict} at {model.confidence.toFixed(2)} confidence, {model.risk} risk. The gate refused anyway.
        </p>
      )}
      {decision.outcome === 'auto_approved' && decision.state === 'active' && (
        <p className="mt-2 flex items-start gap-1.5 text-sm text-emerald-900">
          <ShieldCheckIcon className="mt-0.5 h-4 w-4 shrink-0" />
          Approved for this commit only. Any push withdraws it.
        </p>
      )}
      <p className="mt-2 break-words text-sm text-slate-700">{decision.reason}</p>
      {decision.state !== 'active' && <p className="mt-1 text-sm text-slate-500">Invalidated: {decision.invalidatedReason}{decision.dismissedAt ? '. The approval was dismissed at the host.' : ''}</p>}
      {decision.outcome === 'shadow' && <p className="mt-1 text-sm text-sky-900">Observation only: this system would have {decision.would === 'approve' ? 'approved' : 'sent this to a person'}, and did neither.{decision.humanOutcome ? ` A person ${decision.humanOutcome.replace('_', ' ')}.` : ''}</p>}
    </section>
  )
}
