import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { QuoteCard } from '@/components/portal/QuoteCard'
import { ComponentTable } from '@/components/portal/ComponentTable'
import { InputsPanel } from '@/components/quote/InputsPanel'
import { Timeline } from '@/components/quote/Timeline'
import { PageHeader } from '@/components/shared/PageHeader'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { usePolling } from '@/lib/hooks'
import { shortId } from '@/lib/format'
import { api } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/quotes/$quoteId')({ component: QuoteDetailPage })

export function QuoteDetailPage() {
  const { quoteId } = Route.useParams()
  const user = useAuthStore((s) => s.user)
  const quote = usePolling(() => api.quote(quoteId), 2000, [quoteId])
  const events = usePolling(() => api.quoteEvents(quoteId), 2000, [quoteId])
  const [error, setError] = useState<string | null>(null)
  const [booking, setBooking] = useState(false)

  async function book() {
    setBooking(true)
    try {
      await api.book(quoteId, `book-${quoteId}`)
      quote.reload()
      events.reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBooking(false)
    }
  }

  if (quote.error && !quote.data) return <div className="page"><ErrorNote message={quote.error} /></div>
  if (!quote.data) return <Loading />
  const q = quote.data.quote
  return (
    <div className="page">
      <PageHeader
        title={`Quote ${shortId(q.id)}`}
        subtitle={<>Requested {new Date(q.createdAt).toLocaleString()} {q.customerName ? `by ${q.customerName}` : ''} · <Link to="/" className="text-accent-700 hover:underline">back to quotes</Link></>}
      />
      <ErrorNote message={error} />
      <div className="grid grid-cols-[1fr,380px] gap-5">
        <div className="min-w-0 space-y-4">
          <QuoteCard quote={q} onBook={user?.role === 'customer' ? () => void book() : undefined} booking={booking} />
          <ComponentTable components={q.components} quantity={q.quantity} />
          <InputsPanel quote={q} />
        </div>
        <div>{events.data ? <Timeline events={events.data.events} causes={events.data.causes} deliveries={events.data.deliveries} /> : <Loading />}</div>
      </div>
    </div>
  )
}
