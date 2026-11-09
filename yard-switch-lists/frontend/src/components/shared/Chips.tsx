import type { MoveStatus, PlanVersion, Readiness, Violation } from '@/types'

const tone = {
  good: 'bg-emerald-100 text-emerald-800',
  warn: 'bg-amber-100 text-amber-900',
  bad: 'bg-rose-100 text-rose-900',
  info: 'bg-sky-100 text-sky-800',
  muted: 'bg-slate-100 text-slate-600',
}

export function Chip({ kind, children }: { kind: keyof typeof tone; children: React.ReactNode }) {
  return <span className={`chip ${tone[kind]}`}>{children}</span>
}

export function MoveStatusChip({ status }: { status: MoveStatus }) {
  if (status === 'done') return <Chip kind="good">done</Chip>
  if (status === 'in_progress') return <Chip kind="info">in progress</Chip>
  if (status === 'cancelled') return <Chip kind="muted">cancelled</Chip>
  return <Chip kind="muted">pending</Chip>
}

export function VersionChip({ status }: { status: PlanVersion['status'] }) {
  if (status === 'published') return <Chip kind="good">published</Chip>
  if (status === 'draft') return <Chip kind="warn">draft</Chip>
  return <Chip kind="muted">superseded</Chip>
}

const READINESS: Record<Readiness['status'], { kind: keyof typeof tone; label: string }> = {
  ready: { kind: 'good', label: 'ready' },
  short: { kind: 'warn', label: 'short' },
  annulled: { kind: 'bad', label: 'misses departure' },
  late: { kind: 'bad', label: 'late' },
  departed: { kind: 'muted', label: 'departed' },
  missed: { kind: 'bad', label: 'missed' },
  blocked: { kind: 'bad', label: 'blocked by hold' },
}

export function ReadinessChip({ status }: { status: Readiness['status'] }) {
  return <Chip kind={READINESS[status].kind}>{READINESS[status].label}</Chip>
}

export function SeverityChip({ severity }: { severity: Violation['severity'] }) {
  if (severity === 'safety') return <Chip kind="bad">safety</Chip>
  if (severity === 'physical') return <Chip kind="bad">can&apos;t be done</Chip>
  return <Chip kind="warn">operating rule</Chip>
}
