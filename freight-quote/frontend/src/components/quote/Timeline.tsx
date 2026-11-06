import { money, ms, shortId, time } from '@/lib/format'
import type { Delivery, StoredEvent } from '@/types'

const DOT: Record<string, string> = {
  QuoteRequested: 'bg-slate-400',
  QuoteIssued: 'bg-accent-500',
  FirmQuoteCompleted: 'bg-emerald-500',
  QuoteBooked: 'bg-accent-700',
  QuoteExpired: 'bg-slate-300',
  TariffPublished: 'bg-amber-500',
  FuelSurchargeChanged: 'bg-amber-500',
}

function summary(e: StoredEvent): string {
  const p = e.payload as Record<string, unknown>
  switch (e.type) {
    case 'QuoteRequested':
      return `${String(p.client_class)} request, deadline ${String(p.deadline_ms)} ms${p.needs_firm ? '' : ''}`
    case 'QuoteIssued':
      return `${String(p.kind)} rev ${String(p.revision)} · ${money(Number(p.total_cents))}${p.reason ? ` · ${String(p.reason).replace('_', ' ')}` : ''}`
    case 'FirmQuoteCompleted':
      return `firm ${money(Number(p.total_cents))} (indicative was ${money(Number(p.indicative_total_cents))}) after ${ms(Number(p.completion_ms))}, attempt ${String(p.attempts)}`
    case 'QuoteBooked':
      return `booked at ${money(Number(p.honored_total_cents))}, honoring tariff ${String(p.honored_tariff_version ?? 'contract')} (current ${String(p.current_tariff_version ?? '—')})`
    case 'QuoteExpired':
      return `${String(p.kind)} quote expired`
    case 'TariffPublished':
      return `${String(p.tariff_id)} v${String(p.version)} → ${money(Number(p.rate_per_car_cents))}/car`
    case 'FuelSurchargeChanged':
      return `${String(p.cents_per_mile)}¢/car-mile from week of ${String(p.effective_date)}`
    default:
      return ''
  }
}

/** The quote's own stream in order, with causes from other streams (a tariff that re-priced it) inlined. */
export function Timeline({ events, causes, deliveries }: { events: StoredEvent[]; causes: StoredEvent[]; deliveries: Delivery[] }) {
  const byId = new Map([...events, ...causes].map((e) => [e.event_id, e]))
  const merged = [...events, ...causes].sort((a, b) => a.position - b.position)
  return (
    <section className="card p-4" aria-label="Event timeline">
      <div className="panel-title mb-3">Event timeline</div>
      <ol className="relative space-y-4 border-l border-slate-200 pl-5">
        {merged.map((e) => {
          const cause = e.causation_id ? byId.get(e.causation_id) : undefined
          const external = !e.stream_id.startsWith('quote-')
          const lagMs = new Date(e.recorded_at).getTime() - new Date(e.occurred_at).getTime()
          return (
            <li key={e.event_id} className="relative">
              <span className={`absolute -left-[26px] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-white ${DOT[e.type] ?? 'bg-slate-400'}`} />
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium text-slate-900">{e.type}</span>
                <span className="chip bg-slate-100 font-mono text-slate-600">v{e.version}</span>
                {external ? <span className="chip bg-amber-50 text-amber-800">{e.stream_id}</span> : <span className="text-xs text-slate-400">#{e.stream_version}</span>}
                <span className="text-xs text-slate-400">{time(e.occurred_at)}</span>
                {lagMs > 1000 && <span className="text-xs text-slate-400">(recorded {Math.round(lagMs / 1000)} s later)</span>}
              </div>
              <div className="text-sm text-slate-600">{summary(e)}</div>
              <div className="mt-0.5 font-mono text-[11px] text-slate-400">
                {e.producer} · event {shortId(e.event_id)}
                {cause && <> · caused by {cause.type} {shortId(cause.event_id)}</>}
                {!e.published_at && ' · in outbox'}
              </div>
            </li>
          )
        })}
        {deliveries.map((d) => (
          <li key={d.id} className="relative">
            <span className={`absolute -left-[26px] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-white ${d.status === 'delivered' ? 'bg-emerald-500' : d.status === 'dead' ? 'bg-red-500' : 'bg-amber-400'}`} />
            <div className="font-medium text-slate-900">Webhook {d.status}</div>
            <div className="text-sm text-slate-600">
              signed callback for event {shortId(d.event_id)} · {d.attempts} attempt{d.attempts === 1 ? '' : 's'}
              {d.last_status_code ? ` · HTTP ${d.last_status_code}` : ''}
              {d.last_error ? ` · ${d.last_error}` : ''}
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}
