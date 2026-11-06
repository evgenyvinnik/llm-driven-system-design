import { Link } from '@tanstack/react-router'
import { ClockIcon, LockIcon, SpinnerIcon } from '@/components/icons'
import { KindBadge, StatusBadge } from '@/components/shared/Badges'
import { money, ms, validity } from '@/lib/format'
import { useTicker } from '@/lib/hooks'
import type { Quote } from '@/types'

interface Props {
  quote: Quote
  onBook?: () => void
  booking?: boolean
  showDetailsLink?: boolean
}

export function QuoteCard({ quote, onBook, booking, showDetailsLink }: Props) {
  useTicker(1000)
  const v = validity(quote.validUntil)
  const pending = quote.kind === 'indicative' && quote.firmStatus === 'pending'
  return (
    <section className="card p-4" aria-label="Quote">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2" aria-live="polite">
            <KindBadge quote={quote} />
            <StatusBadge status={quote.status} />
            {quote.revision > 1 && <span className="chip bg-slate-100 text-slate-600">revision {quote.revision}</span>}
          </div>
          <div className="mt-2 text-sm text-slate-600">
            {quote.origin} → {quote.destination} · {quote.quantity} × {quote.equipment.replace('_', ' ').toLowerCase()} · {quote.commodity.toLowerCase()} · ship week {quote.shipWeek}
          </div>
        </div>
        <div className="shrink-0 text-right">
          {quote.kind === 'firm' ? (
            <div className="text-3xl font-semibold tabular-nums text-slate-900">{money(quote.totalCents)}</div>
          ) : (
            <>
              <div className="text-3xl font-semibold tabular-nums text-slate-900">≈ {money(quote.totalCents)}</div>
              <div className="text-xs text-slate-500">
                firm price expected {money(quote.band.lowCents)} – {money(quote.band.highCents)}
              </div>
            </>
          )}
          <div className="text-xs text-slate-400">{money(Math.round(quote.totalCents / quote.quantity))} per car</div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-slate-100 pt-3 text-sm">
        <span className={`flex items-center gap-1.5 ${v.expired ? 'text-red-600' : 'text-slate-600'}`}>
          <ClockIcon /> {quote.kind === 'firm' ? 'Firm price ' : 'Estimate '}
          {v.label}
        </span>
        <span className="text-slate-500">answered in {ms(quote.latencyMs)}</span>
        {quote.inputs.pricingBasis === 'contract' && (
          <span className="flex items-center gap-1 text-slate-600" title="Priced from your contract; never shared with other customers">
            <LockIcon /> contract {quote.inputs.contractId}
          </span>
        )}
        {pending && (
          <span className="flex items-center gap-1.5 text-amber-700">
            <SpinnerIcon /> Confirming capacity and car supply; the firm quote follows{quote.callback ? ' (and goes to your webhook)' : ''}
          </span>
        )}
        {quote.firmStatus === 'delayed' && <span className="text-red-700">Firm quote delayed: a dependency is down. Operations has been alerted.</span>}
        <div className="flex-1" />
        {showDetailsLink && (
          <Link to="/quotes/$quoteId" params={{ quoteId: quote.id }} className="btn-ghost">
            Details & timeline
          </Link>
        )}
        {quote.booking ? (
          <span className="chip bg-accent-100 text-accent-700">Booked at {money(quote.booking.honoredTotalCents)}</span>
        ) : (
          onBook && (
            <button type="button" className="btn-primary" disabled={!quote.bookable || booking} onClick={onBook} title={quote.bookable ? 'Book at this price' : 'Only open, firm quotes can be booked'}>
              {booking ? 'Booking…' : 'Book at this price'}
            </button>
          )
        )}
      </div>
    </section>
  )
}
