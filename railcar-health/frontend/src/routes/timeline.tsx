import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { EventDetailPanel } from '@/components/events/EventDetailPanel'
import { EventList } from '@/components/events/EventList'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { PageHeader } from '@/components/shared/PageHeader'
import { TierBadge } from '@/components/shared/TierBadge'
import { shortId } from '@/lib/events'
import { useFetch } from '@/lib/hooks'
import { api } from '@/services/api'
import { useLiveStore } from '@/stores/live-store'

interface Search {
  car?: string
  case?: string
  event?: string
}

export const Route = createFileRoute('/timeline')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    car: typeof s.car === 'string' ? s.car : undefined,
    case: typeof s.case === 'string' ? s.case : undefined,
    event: typeof s.event === 'string' ? s.event : undefined,
  }),
  component: TimelinePage,
})

export function TimelinePage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/timeline' })
  const revision = useLiveStore((s) => s.revisions.alerts + s.revisions.trips)
  const load = () => (search.case ? api.caseTimeline(search.case) : api.carTimeline(search.car ?? ''))
  const { data, error } = useFetch(load, [search.car, search.case, revision])
  const select = (eventId: string) => void navigate({ search: (prev: Search) => ({ ...prev, event: eventId }), replace: true })
  useEffect(() => {
    if (search.event) document.getElementById(`ev-${search.event}`)?.scrollIntoView({ block: 'nearest' })
  }, [search.event, data])

  if (!search.car && !search.case) return <div className="page"><ErrorNote message="Open a timeline from a car page or an alert." /></div>
  if (error) return <div className="page"><ErrorNote message={error} /></div>
  if (!data) return <Loading />
  const s = data.subject
  const selected = search.event ?? data.events[data.events.length - 1]?.eventId ?? null
  return (
    <div className="flex h-full flex-col">
      <div className="px-6 pt-6">
        <PageHeader
          title={s.kind === 'car' ? <>Event timeline · <span className="font-mono">{s.id}</span></> : <>Case timeline · <span className="font-mono">{shortId(s.id)}</span></>}
          subtitle={
            s.kind === 'car'
              ? 'Every event tagged with this car: its own stream (wheelset swaps), its cases and its trips. Ordered by global position (when each was committed); event time is when it happened, recorded time is when the system learned it.'
              : 'The case stream (the event-sourced aggregate: its version is its last event), plus the events in other streams that caused it or that it caused.'
          }
          actions={
            s.kind === 'case' ? (
              <span className="flex items-center gap-2 text-sm">
                {s.tier ? <TierBadge tier={s.tier} /> : null}
                <span className="chip bg-slate-100 text-slate-700">{s.caseType} · {s.status} · v{s.version}</span>
                {s.carId && <Link to="/timeline" search={{ car: s.carId }} className="text-accent-700 hover:underline">car timeline</Link>}
              </span>
            ) : (
              <Link to="/cars/$carId" params={{ carId: s.id }} className="text-sm text-accent-700 hover:underline">car page</Link>
            )
          }
        />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_420px] gap-4 px-6 pb-6">
        <section className="card min-h-0 overflow-y-auto"><EventList events={data.events} selected={selected} onSelect={select} /></section>
        <section className="card min-h-0 overflow-y-auto p-4">{selected ? <EventDetailPanel eventId={selected} onSelect={select} /> : <p className="text-sm text-slate-500">Select an event.</p>}</section>
      </div>
    </div>
  )
}
