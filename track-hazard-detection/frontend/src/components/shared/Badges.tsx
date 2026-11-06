import type { ResponseStatus, Severity } from '@/types'
import { humanize } from '@/lib/format'

const SEVERITY_CLASS: Record<Severity, string> = {
  CRITICAL: 'bg-sev-critical text-white',
  HIGH: 'bg-sev-high text-white',
  MEDIUM: 'bg-sev-medium text-slate-900',
  LOW: 'bg-slate-200 text-slate-700',
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={`chip font-semibold ${SEVERITY_CLASS[severity]}`}>{severity}</span>
}

const STATUS_CLASS: Record<ResponseStatus, string> = {
  alerting: 'bg-red-50 text-red-700 ring-1 ring-red-200',
  acknowledged: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
  responding: 'bg-sky-50 text-sky-800 ring-1 ring-sky-200',
  cleared: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  false_alarm: 'bg-slate-100 text-slate-600 ring-1 ring-slate-200',
}

export function StatusBadge({ status }: { status: ResponseStatus }) {
  return <span className={`chip ${STATUS_CLASS[status]}`}>{humanize(status)}</span>
}

export function DetectionBadge({ status }: { status: string }) {
  const cls = status === 'confirmed' ? 'bg-red-100 text-red-800' : status === 'detected' ? 'bg-orange-100 text-orange-800' : status.startsWith('risk') ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'
  return <span className={`chip ${cls}`}>{humanize(status)}</span>
}

export function LaneBadge({ lane }: { lane: string | null | undefined }) {
  if (!lane) return null
  const cls = lane === 'critical' ? 'bg-red-50 text-red-700 ring-1 ring-red-200' : lane === 'domain' ? 'bg-violet-50 text-violet-700 ring-1 ring-violet-200' : lane === 'trains' ? 'bg-sky-50 text-sky-700 ring-1 ring-sky-200' : 'bg-slate-100 text-slate-600 ring-1 ring-slate-200'
  return <span className={`chip ${cls}`}>{lane}</span>
}

export function LateBadge({ late }: { late: boolean | undefined }) {
  return late ? <span className="chip bg-purple-100 text-purple-800" title="Occurred before the segment watermark: delivered late (e.g. buffered at the edge while the link was down)">late</span> : null
}
