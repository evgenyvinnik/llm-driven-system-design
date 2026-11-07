import type { FlagStatus } from '@exp/core'

const STYLES: Record<FlagStatus, string> = {
  draft: 'bg-slate-100 text-slate-600',
  running: 'bg-emerald-100 text-emerald-800',
  paused: 'bg-amber-100 text-amber-800',
  stopped: 'bg-rose-100 text-rose-800',
}

export function StatusChip({ status }: { status: FlagStatus }) {
  return (
    <span className={`chip ${STYLES[status]}`} data-status={status}>
      <span className={`h-1.5 w-1.5 rounded-full ${status === 'running' ? 'bg-emerald-500' : status === 'paused' ? 'bg-amber-500' : status === 'stopped' ? 'bg-rose-500' : 'bg-slate-400'}`} />
      {status}
    </span>
  )
}

export function KindChip({ kind }: { kind: 'flag' | 'experiment' }) {
  return <span className={`chip ${kind === 'experiment' ? 'bg-accent-50 text-accent-700' : 'bg-sky-50 text-sky-700'}`}>{kind}</span>
}
