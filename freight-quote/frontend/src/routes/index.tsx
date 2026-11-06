import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useState } from 'react'
import { QuoteForm } from '@/components/portal/QuoteForm'
import { QuoteCard } from '@/components/portal/QuoteCard'
import { ComponentTable } from '@/components/portal/ComponentTable'
import { RecentQuotes } from '@/components/portal/RecentQuotes'
import { PageHeader } from '@/components/shared/PageHeader'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { usePolling } from '@/lib/hooks'
import { api, ApiError, type QuoteForm as Form } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'
import type { Quote } from '@/types'

export const Route = createFileRoute('/')({ component: QuotesPage })

export function QuotesPage() {
  const user = useAuthStore((s) => s.user)
  return user?.role === 'customer' ? <Portal /> : <AllQuotes />
}

function AllQuotes() {
  const { data, error } = usePolling(() => api.quotes({ limit: 100 }), 3000)
  return (
    <div className="page">
      <PageHeader title="All quotes" subtitle="Every customer's quotes, newest first. Customers only ever see their own." />
      <ErrorNote message={error} />
      {data ? <RecentQuotes quotes={data.quotes} showCustomer /> : <Loading />}
    </div>
  )
}

function Portal() {
  const reference = usePolling(() => api.reference(), null)
  const recent = usePolling(() => api.quotes({ limit: 12 }), 4000)
  const [current, setCurrent] = useState<Quote | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [booking, setBooking] = useState(false)
  const [submissions, setSubmissions] = useState(0)

  // 202 + polling: follow an indicative quote until the async completer makes it firm.
  const following = current && current.kind === 'indicative' && current.firmStatus === 'pending' ? current.id : null
  usePolling(
    useCallback(async () => {
      if (!following) return null
      const { quote } = await api.quote(following)
      setCurrent(quote)
      return quote
    }, [following]),
    following ? 1000 : null,
    [following],
  )

  async function submit(form: Form, key: string) {
    setBusy(true)
    setError(null)
    try {
      const r = await api.submitQuote(form, key)
      setCurrent(r.quote)
      setNote(r.replayed ? 'Same Idempotency-Key as an earlier submission: the server returned that quote instead of making a new one.' : r.httpStatus === 202 ? '202 Accepted: an indicative quote now, the firm quote follows.' : '201 Created: firm quote.')
      setSubmissions((n) => n + 1)
      recent.reload()
    } catch (err) {
      const e = err as ApiError
      setError(e.status === 0 ? 'Network error. Submitting again reuses the same Idempotency-Key, so you will not get a duplicate quote.' : `${e.code}: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  async function book() {
    if (!current) return
    setBooking(true)
    try {
      const { quote } = await api.book(current.id, `book-${current.id}`)
      setCurrent(quote)
      recent.reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBooking(false)
    }
  }

  if (!reference.data) return <Loading />
  return (
    <div className="page">
      <PageHeader title="Quotes" subtitle="A firm quote is a price we commit to. When network capacity or car supply can't be confirmed in time, you get an indicative estimate at once, labeled with what is not yet confirmed, and the firm quote follows within seconds." />
      <div className="grid grid-cols-[340px,1fr] gap-5">
        <QuoteForm reference={reference.data} busy={busy} onSubmit={(f, k) => void submit(f, k)} submissionCount={submissions} />
        <div className="min-w-0 space-y-4">
          <ErrorNote message={error} />
          {current ? (
            <>
              {note && (
                <p className="text-xs text-slate-500">
                  {note}
                  {current.kind === 'firm' && current.firmStatus === 'completed' ? ' The firm quote has arrived.' : ''}
                </p>
              )}
              <QuoteCard quote={current} onBook={() => void book()} booking={booking} showDetailsLink />
              <ComponentTable components={current.components} quantity={current.quantity} />
            </>
          ) : (
            <div className="card flex h-40 items-center justify-center text-sm text-slate-500">Choose a lane and request a quote.</div>
          )}
        </div>
      </div>
      <h2 className="mb-2 mt-8 text-sm font-semibold text-slate-700">Your recent quotes</h2>
      {recent.data ? <RecentQuotes quotes={recent.data.quotes} /> : <Loading />}
    </div>
  )
}
