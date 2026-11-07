import type { RunStatus, TaskStatus } from '@/types'

const RUN: Record<RunStatus, string> = {
  queued: 'bg-slate-100 text-slate-700',
  running: 'bg-sky-100 text-sky-800',
  completed: 'bg-emerald-100 text-emerald-800',
  cancelled: 'bg-amber-100 text-amber-800',
  failed: 'bg-rose-100 text-rose-800',
}

export function RunStatusChip({ status, errored = 0 }: { status: RunStatus; errored?: number }) {
  const label = status === 'completed' && errored > 0 ? `completed, ${errored} errored` : status
  const tone = status === 'completed' && errored > 0 ? 'bg-amber-100 text-amber-900' : RUN[status]
  return <span className={`chip ${tone}`}>{label}</span>
}

const TASK: Record<TaskStatus, string> = {
  pending: 'bg-slate-100 text-slate-600',
  running: 'bg-sky-100 text-sky-800',
  succeeded: 'bg-emerald-50 text-emerald-800',
  errored: 'bg-rose-100 text-rose-800',
  cancelled: 'bg-amber-50 text-amber-800',
}

export function TaskChip({ status }: { status: TaskStatus }) {
  return <span className={`chip ${TASK[status]}`}>{status}</span>
}

export function PassChip({ passed, score }: { passed: boolean | null; score?: number | null }) {
  if (passed === null) return <span className="chip bg-slate-100 text-slate-500">unscored</span>
  const partial = score !== undefined && score !== null && score > 0 && score < 1
  if (partial) return <span className="chip bg-amber-50 text-amber-800">{score.toFixed(2)}</span>
  return passed ? <span className="chip bg-emerald-50 text-emerald-800">pass</span> : <span className="chip bg-rose-50 text-rose-800">fail</span>
}

export function Tag({ children }: { children: string }) {
  return <span className="chip bg-slate-100 font-normal text-slate-600">{children}</span>
}
