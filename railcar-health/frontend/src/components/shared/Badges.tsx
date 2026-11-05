import { ArrowUpIcon, CloudOffIcon, LockIcon } from '@/components/icons'
import { lagText } from '@/lib/format'

export function LateBadge({ lagSeconds }: { lagSeconds: number }) {
  return (
    <span className="chip bg-violet-50 text-violet-800 ring-1 ring-violet-200" title="This evidence reached the system long after the train passed the detector">
      <CloudOffIcon className="h-3.5 w-3.5" /> data {lagText(lagSeconds)} late
    </span>
  )
}

export function HoldBadge({ status }: { status: string | null }) {
  if (!status || status === 'released') return null
  return (
    <span className="chip whitespace-nowrap bg-slate-800 text-white">
      <LockIcon className="h-3 w-3" /> {status === 'bad_ordered' ? 'bad-ordered' : 'car held'}
    </span>
  )
}

export function EscalatedBadge() {
  return (
    <span className="chip bg-white text-slate-700 ring-1 ring-slate-300">
      <ArrowUpIcon className="h-3 w-3" /> escalated
    </span>
  )
}

const DETECTOR_STYLE: Record<string, string> = {
  ok: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200',
  offline: 'bg-violet-50 text-violet-800 ring-1 ring-violet-200',
  silent: 'bg-red-50 text-red-800 ring-1 ring-red-200',
  biased: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
}

export function DetectorStatusBadge({ status }: { status: string }) {
  const label = { ok: 'OK', offline: 'Offline (buffering)', silent: 'Silent', biased: 'Biased' }[status] ?? status
  return <span className={`chip ${DETECTOR_STYLE[status] ?? DETECTOR_STYLE.ok}`}>{label}</span>
}
