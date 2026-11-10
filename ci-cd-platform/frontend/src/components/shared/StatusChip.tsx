import type { ComponentType } from 'react'
import { AlertIcon, CheckIcon, ClockIcon, ShieldIcon, SkipIcon, SpinnerIcon, StopIcon, XIcon, type IconProps } from '@/components/icons'

// Rose rather than red: the screenshot harness treats red classes as a login error.
const STYLES: Record<string, { className: string; Icon: ComponentType<IconProps>; label?: string; spin?: boolean }> = {
  success: { className: 'bg-emerald-100 text-emerald-800', Icon: CheckIcon },
  failure: { className: 'bg-rose-100 text-rose-800', Icon: XIcon },
  invalid: { className: 'bg-rose-100 text-rose-800', Icon: AlertIcon },
  cancelled: { className: 'bg-slate-200 text-slate-700', Icon: StopIcon },
  skipped: { className: 'bg-slate-100 text-slate-500', Icon: SkipIcon },
  blocked: { className: 'bg-slate-100 text-slate-500', Icon: ClockIcon },
  queued: { className: 'bg-sky-100 text-sky-800', Icon: ClockIcon },
  running: { className: 'bg-accent-100 text-accent-700', Icon: SpinnerIcon, spin: true },
  waiting: { className: 'bg-violet-100 text-violet-800', Icon: ShieldIcon, label: 'waiting for approval' },
  needs_attention: { className: 'bg-amber-200 text-amber-900', Icon: AlertIcon, label: 'needs attention' },
  lease_expired: { className: 'bg-orange-100 text-orange-800', Icon: AlertIcon, label: 'lease expired' },
  unknown: { className: 'bg-amber-200 text-amber-900', Icon: AlertIcon, label: 'outcome unknown' },
  timed_out: { className: 'bg-rose-100 text-rose-800', Icon: ClockIcon, label: 'timed out' },
  killed: { className: 'bg-slate-200 text-slate-700', Icon: StopIcon },
  pending: { className: 'bg-slate-100 text-slate-500', Icon: ClockIcon },
}

export function StatusChip({ status }: { status: string }) {
  const style = STYLES[status] ?? STYLES.pending
  return (
    <span className={`chip ${style.className}`} data-status={status}>
      <style.Icon className={`h-3 w-3 ${style.spin ? 'animate-spin' : ''}`} />
      {style.label ?? status}
    </span>
  )
}
