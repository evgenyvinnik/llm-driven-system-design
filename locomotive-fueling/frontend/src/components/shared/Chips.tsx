/**
 * Status chips. Every status carries a text label (never color alone), and
 * the reserved status colors (green / amber / red) are used only for state.
 */
import { titleCase } from '@/lib/format'
import type { Confidence, Lifecycle, PlanSource } from '@/types'

const tone = {
  good: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200',
  warn: 'bg-amber-50 text-amber-900 ring-1 ring-amber-200',
  bad: 'bg-red-50 text-red-800 ring-1 ring-red-200',
  info: 'bg-sky-50 text-sky-800 ring-1 ring-sky-200',
  muted: 'bg-slate-100 text-slate-600 ring-1 ring-slate-200',
}

export function Chip({ kind, children, title }: { kind: keyof typeof tone; children: React.ReactNode; title?: string }) {
  return (
    <span className={`chip ${tone[kind]}`} title={title}>
      {children}
    </span>
  )
}

const ORDER_TONE: Record<string, keyof typeof tone> = {
  pending: 'info',
  unknown: 'warn',
  confirmed: 'good',
  delivered: 'good',
  reconciled: 'good',
  rejected: 'bad',
  failed: 'bad',
  discrepancy: 'bad',
  cancel_requested: 'warn',
  cancelled: 'muted',
}

export function OrderStatus({ status }: { status: string }) {
  const label = status === 'unknown' ? 'Outcome unknown' : titleCase(status)
  return <Chip kind={ORDER_TONE[status] ?? 'muted'}>{label}</Chip>
}

const LIFECYCLE: Record<Lifecycle, [keyof typeof tone, string]> = {
  recommended: ['info', 'Recommended'],
  accepted: ['good', 'Accepted'],
  proposed: ['warn', 'Change proposed'],
  superseded: ['muted', 'Superseded'],
  rejected: ['muted', 'Rejected'],
}

export function LifecycleChip({ lifecycle }: { lifecycle: Lifecycle }) {
  const [kind, label] = LIFECYCLE[lifecycle] ?? ['muted', lifecycle]
  return <Chip kind={kind}>{label}</Chip>
}

export function ConfidenceChip({ confidence }: { confidence: Confidence }) {
  const kind = confidence === 'high' ? 'good' : confidence === 'medium' ? 'warn' : 'bad'
  return (
    <Chip kind={kind} title="How much the inputs can be trusted; lower confidence widens the safety margin">
      {titleCase(confidence)} confidence
    </Chip>
  )
}

export function SourceChip({ source }: { source: PlanSource }) {
  if (source === 'dp') return <Chip kind="muted">Optimized</Chip>
  return <Chip kind="warn">{source === 'greedy_fallback' ? 'Greedy fallback' : 'Last good plan'}</Chip>
}

export function Severity({ severity }: { severity: 'info' | 'warning' | 'critical' }) {
  return <Chip kind={severity === 'critical' ? 'bad' : severity === 'warning' ? 'warn' : 'info'}>{titleCase(severity)}</Chip>
}

const COMMIT_TONE: Record<string, keyof typeof tone> = { accepted: 'good', executing: 'info', fueled: 'good', cancelled: 'muted', expired: 'warn' }

export function CommitmentChip({ state }: { state: string | null }) {
  if (!state) return <Chip kind="muted">Not reserved</Chip>
  const label = state === 'accepted' ? 'Bay reserved' : state === 'executing' ? 'Fueling now' : titleCase(state)
  return <Chip kind={COMMIT_TONE[state] ?? 'muted'}>{label}</Chip>
}
