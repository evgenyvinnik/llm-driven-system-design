import type { RequestStatus } from '@/types'

const STYLES: Record<string, string> = {
  queued: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
  submitting: 'bg-slate-100 text-slate-700',
  running: 'bg-sky-50 text-sky-800 ring-1 ring-sky-200',
  completed: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200',
  cancelled: 'bg-slate-100 text-slate-700 ring-1 ring-slate-300',
  failed: 'bg-rose-50 text-rose-800 ring-1 ring-rose-200',
  detached: 'bg-violet-50 text-violet-800 ring-1 ring-violet-200',
  ok: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200',
  draining: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
  restarting: 'bg-rose-50 text-rose-800 ring-1 ring-rose-200',
  unknown: 'bg-slate-100 text-slate-600',
  idle: 'bg-slate-100 text-slate-600',
}

export function StatusChip({ status }: { status: RequestStatus | string }) {
  return <span className={`chip ${STYLES[status] ?? STYLES.unknown}`}>{status}</span>
}

export function ClassChip({ cls }: { cls: string }) {
  return <span className={`chip ${cls === 'interactive' ? 'bg-accent-50 text-accent-700' : 'bg-orange-50 text-orange-800'}`}>{cls}</span>
}
