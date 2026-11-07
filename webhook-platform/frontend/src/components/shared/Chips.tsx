/**
 * Status chips. Each chip pairs a colour with a word, so meaning never rests
 * on colour alone.
 */
import type { DeliveryState } from '@/types'
import { ERROR_CLASS_LABEL } from '@/lib/format'

const STATE_STYLE: Record<DeliveryState, string> = {
  delivered: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  failed: 'bg-red-50 text-red-700 ring-red-200',
  scheduled: 'bg-amber-50 text-amber-800 ring-amber-200',
  queued: 'bg-sky-50 text-sky-700 ring-sky-200',
  in_flight: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
}

const STATE_LABEL: Record<DeliveryState, string> = {
  delivered: 'Delivered',
  failed: 'Failed',
  scheduled: 'Retry scheduled',
  queued: 'Queued',
  in_flight: 'In flight',
}

export function StateChip({ state }: { state: DeliveryState }) {
  return <span className={`chip ring-1 ring-inset ${STATE_STYLE[state]}`}>{STATE_LABEL[state]}</span>
}

export function EndpointStatusChip({ status, probing, paused }: { status: 'active' | 'disabled'; probing?: boolean; paused?: boolean }) {
  if (status === 'disabled') return <span className="chip bg-red-50 text-red-700 ring-1 ring-inset ring-red-200">Disabled</span>
  if (paused) return <span className="chip bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200">Paused (429)</span>
  if (probing) return <span className="chip bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200">Failing · probing</span>
  return <span className="chip bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200">Active</span>
}

const OUTCOME_STYLE: Record<string, string> = {
  delivered: 'text-emerald-700',
  retry: 'text-amber-700',
  failed: 'text-red-700',
  superseded: 'text-slate-500',
  lost: 'text-slate-500',
}

export function OutcomeText({ outcome }: { outcome: string }) {
  const label = { delivered: 'Delivered', retry: 'Will retry', failed: 'Stopped', superseded: 'Superseded', lost: 'Outcome unknown' }[outcome] ?? outcome
  return <span className={`text-xs font-semibold ${OUTCOME_STYLE[outcome] ?? 'text-slate-600'}`}>{label}</span>
}

export function ErrorClassText({ errorClass }: { errorClass: string | null }) {
  if (!errorClass) return <span className="text-slate-400">—</span>
  return <span className={errorClass === 'ok' ? 'text-slate-600' : 'text-slate-800'}>{ERROR_CLASS_LABEL[errorClass] ?? errorClass}</span>
}

export function TypeChip({ type }: { type: string }) {
  return <span className="chip bg-slate-100 font-mono text-slate-700">{type}</span>
}
