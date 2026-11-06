import type { ComponentSource, Quote } from '@/types'

export function KindBadge({ quote }: { quote: Pick<Quote, 'kind' | 'firmStatus'> }) {
  if (quote.kind === 'firm') return <span className="chip bg-emerald-100 text-emerald-800">Firm</span>
  if (quote.firmStatus === 'delayed') return <span className="chip bg-red-100 text-red-800">Indicative · firm delayed</span>
  return <span className="chip bg-amber-100 text-amber-800">Indicative</span>
}

export function StatusBadge({ status }: { status: Quote['status'] }) {
  const cls = status === 'booked' ? 'bg-accent-100 text-accent-700' : status === 'expired' ? 'bg-slate-200 text-slate-600' : 'bg-white text-slate-600 ring-1 ring-slate-200'
  return <span className={`chip ${cls}`}>{status}</span>
}

const SOURCE: Record<ComponentSource, { label: string; cls: string; title: string }> = {
  live: { label: 'live', cls: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200', title: 'Answered by the dependency within this request' },
  cache: { label: 'cached', cls: 'bg-sky-50 text-sky-700 ring-1 ring-sky-200', title: 'Served from cache' },
  fallback: { label: 'unconfirmed', cls: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200', title: 'No usable value; estimated and labeled' },
}

export function SourceBadge({ source }: { source: ComponentSource }) {
  const s = SOURCE[source]
  return (
    <span className={`chip ${s.cls}`} title={s.title}>
      {s.label}
    </span>
  )
}

export function BreakerBadge({ state }: { state: 'closed' | 'open' | 'halfOpen' }) {
  const map = {
    closed: 'bg-emerald-100 text-emerald-800',
    halfOpen: 'bg-amber-100 text-amber-800',
    open: 'bg-red-100 text-red-800',
  }
  return <span className={`chip shrink-0 whitespace-nowrap ${map[state]}`}>circuit {state === 'halfOpen' ? 'half-open' : state}</span>
}

export function Stat({ label, value, hint, tone = 'default' }: { label: string; value: string | number; hint?: string; tone?: 'default' | 'bad' | 'good' }) {
  const color = tone === 'bad' ? 'text-red-700' : tone === 'good' ? 'text-emerald-700' : 'text-slate-900'
  return (
    <div className="card px-3 py-2" title={hint}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  )
}
