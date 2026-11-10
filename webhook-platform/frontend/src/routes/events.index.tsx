import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { EventsTable } from '@/components/events/EventsTable'
import { SendEventForm } from '@/components/events/SendEventForm'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'

export const Route = createFileRoute('/events/')({ component: EventsPage })

function EventsPage() {
  const [type, setType] = useState('')
  const { data, error, reload } = usePoll(() => api.events(type || undefined), 2500, [type])
  return (
    <div className="page">
      <div>
        <h1 className="h1">Event log</h1>
        <p className="mt-1 text-sm text-slate-500">Events are immutable. Each one fans out to one delivery per matching endpoint; retries and replays add attempts, never events.</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="card min-w-0">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-900">Recent events</h2>
            <input aria-label="Filter by type" className="input w-48 font-mono text-xs" placeholder="filter: invoice.paid" value={type} onChange={(e) => setType(e.target.value.trim())} />
          </div>
          {error && <div className="p-3"><ErrorNote message={error} /></div>}
          {!data ? <Loading /> : <EventsTable events={data.events} />}
        </section>
        <SendEventForm onSent={reload} />
      </div>
    </div>
  )
}
