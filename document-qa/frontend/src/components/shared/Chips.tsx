/**
 * Status chips. Each pairs a colour with a word, so meaning never rests on
 * colour alone. Failure tones are rose, not red (see ErrorNote).
 */
import type { Scope } from '@/types'

const TONE = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  rose: 'bg-rose-50 text-rose-800 ring-rose-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  sky: 'bg-sky-50 text-sky-700 ring-sky-200',
  indigo: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  slate: 'bg-slate-100 text-slate-600 ring-slate-200',
} as const

type Tone = keyof typeof TONE

const STATUS: Record<string, [Tone, string]> = {
  // documents / versions
  uploaded: ['sky', 'Uploaded'],
  processing: ['indigo', 'Processing'],
  ready: ['green', 'Ready'],
  failed: ['rose', 'Failed'],
  superseded: ['amber', 'Superseded'],
  retired: ['slate', 'Retired'],
  cancelled: ['slate', 'Cancelled'],
  // jobs
  pending: ['sky', 'Pending'],
  running: ['indigo', 'Running'],
  succeeded: ['green', 'Succeeded'],
  poisoned: ['rose', 'Poisoned'],
  // attempts
  retry: ['amber', 'Will retry'],
  lost: ['rose', 'Worker lost'],
  // runs
  queued: ['sky', 'Queued'],
  completed: ['green', 'Completed'],
  // purge artifacts
  done: ['green', 'Done'],
}

export function Chip({ tone, children, title }: { tone: Tone; children: React.ReactNode; title?: string }) {
  return (
    <span className={`chip ring-1 ring-inset ${TONE[tone]}`} title={title}>
      {children}
    </span>
  )
}

export function StatusChip({ status, title }: { status: string; title?: string }) {
  const [tone, label] = STATUS[status] ?? ['slate', status]
  return (
    <Chip tone={tone} title={title}>
      {label}
    </Chip>
  )
}

export function ScopeChip({ scope, groupName }: { scope: Scope; groupName: string | null }) {
  if (scope === 'org') return <Chip tone="green">Org-wide</Chip>
  if (scope === 'group') return <Chip tone="indigo">Group: {groupName ?? '—'}</Chip>
  return <Chip tone="slate">Private</Chip>
}

export function ProgressBar({ done, total, tone = 'accent' }: { done: number; total: number; tone?: 'accent' | 'green' | 'amber' }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  const color = tone === 'green' ? 'bg-emerald-500' : tone === 'amber' ? 'bg-amber-500' : 'bg-accent-500'
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  )
}
