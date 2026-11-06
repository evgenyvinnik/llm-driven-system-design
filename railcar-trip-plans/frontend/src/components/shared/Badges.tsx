import { label } from '@/lib/format'
import type { CarStatus, Confidence, EtaConfidence, PlanStatus, SagaRow } from '@/types'

const STATUS: Record<CarStatus, string> = {
  awaiting_pull: 'bg-slate-100 text-slate-700',
  at_yard: 'bg-sky-50 text-sky-800',
  in_transit: 'bg-indigo-50 text-indigo-800',
  bad_ordered: 'bg-red-50 text-red-700',
  off_network: 'bg-violet-50 text-violet-800',
  delivered: 'bg-emerald-50 text-emerald-800',
  unknown: 'bg-slate-100 text-slate-500',
}

export function StatusBadge({ status }: { status: CarStatus }) {
  return <span className={`chip ${STATUS[status]}`}>{status === 'off_network' ? 'on foreign road' : label(status)}</span>
}

export function PositionBadge({ confidence }: { confidence: Confidence }) {
  if (confidence === 'observed') return <span className="chip bg-slate-100 text-slate-600" title="Position confirmed by a car-level read (AEI, yard system)">observed</span>
  if (confidence === 'inferred') return <span className="chip bg-amber-50 text-amber-800" title="No car-level read; position inferred from train movement">inferred</span>
  return <span className="chip bg-slate-100 text-slate-400">no reads</span>
}

const PLAN: Record<PlanStatus, string> = {
  no_plan: 'bg-slate-100 text-slate-500',
  on_plan: 'bg-emerald-50 text-emerald-800',
  missed_connection: 'bg-red-50 text-red-700',
  replanned: 'bg-amber-50 text-amber-800',
  complete: 'bg-slate-100 text-slate-600',
}

export function PlanBadge({ status, version }: { status: PlanStatus; version: number | null }) {
  return (
    <span className="inline-flex items-center gap-1">
      {version !== null && <span className="chip bg-slate-900 text-white">v{version}</span>}
      <span className={`chip ${PLAN[status]}`}>{label(status)}</span>
    </span>
  )
}

const ETA_CONF: Record<EtaConfidence, string> = { high: 'text-emerald-700', medium: 'text-amber-700', low: 'text-red-700' }

export function EtaConfidenceText({ confidence }: { confidence: EtaConfidence }) {
  return <span className={`text-xs font-medium ${ETA_CONF[confidence]}`}>{confidence} confidence</span>
}

const SEVERITY = { high: 'bg-red-600 text-white', medium: 'bg-amber-400 text-amber-950', low: 'bg-slate-200 text-slate-700' }

export function SeverityBadge({ severity }: { severity: 'low' | 'medium' | 'high' }) {
  return <span className={`chip uppercase ${SEVERITY[severity]}`}>{severity}</span>
}

const SAGA: Record<SagaRow['state'], string> = {
  started: 'bg-sky-50 text-sky-800',
  reserved: 'bg-sky-50 text-sky-800',
  awaiting_eta: 'bg-indigo-50 text-indigo-800',
  completed: 'bg-emerald-50 text-emerald-800',
  failed: 'bg-red-50 text-red-700',
  compensated: 'bg-amber-50 text-amber-800',
  superseded: 'bg-slate-100 text-slate-500',
}

export function SagaStateBadge({ state }: { state: SagaRow['state'] }) {
  return <span className={`chip ${SAGA[state]}`}>{label(state)}</span>
}
