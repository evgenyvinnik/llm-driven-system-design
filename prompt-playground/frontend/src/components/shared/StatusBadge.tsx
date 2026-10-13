import { SpinnerIcon } from '@/components/icons'
import type { RunStatus } from '@/types'

const STYLES: Record<RunStatus, string> = {
  queued: 'bg-slate-100 text-slate-700',
  running: 'bg-accent-50 text-accent-700',
  completed: 'bg-emerald-50 text-emerald-700',
  cancelled: 'bg-amber-50 text-amber-700',
  failed: 'bg-red-50 text-red-700',
}

export function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <span className={`chip ${STYLES[status]}`}>
      {(status === 'running' || status === 'queued') && <SpinnerIcon className="h-3 w-3 animate-spin" />}
      {status}
    </span>
  )
}

const DOTS: Record<RunStatus, string> = {
  queued: 'bg-slate-400',
  running: 'bg-accent-500 animate-pulse',
  completed: 'bg-emerald-500',
  cancelled: 'bg-amber-500',
  failed: 'bg-red-500',
}

export function StatusDot({ status }: { status: RunStatus }) {
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOTS[status]}`} title={status} />
}
