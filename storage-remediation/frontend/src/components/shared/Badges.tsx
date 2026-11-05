import { AlertIcon, CheckIcon, ClockIcon, ShieldIcon } from '@/components/icons'
import { EVIDENCE_COLOR, EVIDENCE_LABEL } from '@/lib/format'
import type { EvidenceClass, Severity, TargetState } from '@/types'

const SEVERITY: Record<Severity, string> = {
  critical: 'bg-red-50 text-red-800 ring-1 ring-red-200',
  high: 'bg-orange-50 text-orange-800 ring-1 ring-orange-200',
  medium: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
  low: 'bg-slate-100 text-slate-700 ring-1 ring-slate-200',
}

/** Severity always carries an icon and a word, never color alone. */
export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className={`chip ${SEVERITY[severity]}`}>
      {severity === 'critical' || severity === 'high' ? <AlertIcon className="h-3 w-3" /> : <ShieldIcon className="h-3 w-3" />}
      {severity}
    </span>
  )
}

export function EvidenceBadge({ value }: { value: EvidenceClass | null }) {
  if (!value) return <span className="chip bg-slate-100 text-slate-500">no evidence yet</span>
  return (
    <span className="chip bg-white text-slate-700 ring-1 ring-slate-200">
      <span className={`h-2 w-2 rounded-full ${EVIDENCE_COLOR[value]}`} aria-hidden />
      {EVIDENCE_LABEL[value]}
    </span>
  )
}

const STATE_STYLE: Record<TargetState, string> = {
  pending: 'bg-slate-100 text-slate-600',
  queued: 'bg-slate-100 text-slate-700',
  applying: 'bg-accent-50 text-accent-800',
  baking: 'bg-accent-50 text-accent-800',
  rolling_back: 'bg-orange-50 text-orange-800',
  verified: 'bg-green-50 text-green-800',
  rolled_back: 'bg-orange-50 text-orange-800',
  skipped: 'bg-slate-100 text-slate-600',
  escalated: 'bg-amber-50 text-amber-800',
  failed: 'bg-red-50 text-red-800',
  cancelled: 'bg-slate-100 text-slate-500',
}

export function StateBadge({ state }: { state: TargetState }) {
  const icon = state === 'verified' ? <CheckIcon className="h-3 w-3" /> : state === 'failed' || state === 'rolled_back' || state === 'escalated' ? <AlertIcon className="h-3 w-3" /> : state === 'baking' ? <ClockIcon className="h-3 w-3" /> : null
  return (
    <span className={`chip ${STATE_STYLE[state]}`}>
      {icon}
      {state.replace('_', ' ')}
    </span>
  )
}

const CAMPAIGN_STYLE: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700',
  running: 'bg-accent-50 text-accent-800',
  paused: 'bg-amber-50 text-amber-800',
  completed: 'bg-green-50 text-green-800',
  killed: 'bg-red-50 text-red-800',
}

export function CampaignStatusBadge({ status }: { status: string }) {
  return (
    <span className={`chip ${CAMPAIGN_STYLE[status] ?? 'bg-slate-100'}`}>
      {status === 'running' && <span className="h-1.5 w-1.5 animate-pulseDot rounded-full bg-accent-600" aria-hidden />}
      {status}
    </span>
  )
}
