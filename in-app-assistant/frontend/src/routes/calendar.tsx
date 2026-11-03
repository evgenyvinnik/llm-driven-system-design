import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { ChevronLeftIcon, ChevronRightIcon, ClockIcon, SparkleIcon } from '@/components/icons'
import { Loading } from '@/components/shared/Loading'
import { addDays, timeOf, ymdIn } from '@/lib/format'
import { api } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { CalendarEvent } from '@/types'

export const Route = createFileRoute('/calendar')({
  validateSearch: (search: Record<string, unknown>): { week?: string; e?: string } => ({
    week: typeof search.week === 'string' ? search.week : undefined,
    e: typeof search.e === 'string' ? search.e : undefined,
  }),
  component: CalendarPage,
})

function mondayOf(ymd: string): string {
  const dow = new Date(`${ymd}T12:00:00Z`).getUTCDay()
  return addDays(ymd, -((dow + 6) % 7))
}

function CalendarPage() {
  const tz = useAuthStore((s) => s.user?.timezone ?? 'UTC')
  const today = ymdIn(new Date(), tz)
  const { week, e: highlight } = Route.useSearch()
  const navigate = Route.useNavigate()
  const start = week ?? mondayOf(today)
  const revision = useWorkspaceStore((s) => s.revision)
  const [events, setEvents] = useState<CalendarEvent[] | null>(null)

  useEffect(() => {
    api.events(start, addDays(start, 6)).then((r) => setEvents(r.events)).catch(() => setEvents([]))
  }, [start, revision])

  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i))
  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-900">Calendar</h1>
        <button type="button" className="btn-secondary px-2" onClick={() => void navigate({ search: { week: addDays(start, -7) } })} aria-label="Previous week"><ChevronLeftIcon /></button>
        <button type="button" className="btn-secondary" onClick={() => void navigate({ search: {} })}>This week</button>
        <button type="button" className="btn-secondary px-2" onClick={() => void navigate({ search: { week: addDays(start, 7) } })} aria-label="Next week"><ChevronRightIcon /></button>
        <span className="text-sm text-slate-500">{tz}</span>
      </div>
      {!events ? <Loading /> : (
        <div className="grid max-w-3xl gap-3">
          {days.map((day) => {
            const items = events.filter((ev) => ymdIn(new Date(ev.start), tz) === day)
            return (
              <section key={day} className={`card p-3 ${day === today ? 'border-accent-300' : ''}`}>
                <h2 className={`mb-2 text-sm font-semibold ${day === today ? 'text-accent-700' : 'text-slate-700'}`}>
                  {new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })}
                  {day === today && ' · Today'}
                </h2>
                {items.length === 0 ? <p className="text-xs text-slate-400">Nothing scheduled</p> : (
                  <ul className="space-y-1.5">
                    {items.map((ev) => (
                      <li key={ev.id} id={ev.id} className={`flex items-start gap-3 rounded-md px-2 py-1.5 text-sm ${ev.id === highlight ? 'animate-flash bg-accent-50' : ''}`}>
                        <span className="flex w-36 shrink-0 items-center gap-1 text-slate-500"><ClockIcon className="h-3.5 w-3.5" /> {timeOf(ev.start, tz)} – {timeOf(ev.end, tz)}</span>
                        <span className="min-w-0">
                          <span className="font-medium text-slate-900">{ev.title}</span>
                          {ev.createdBy === 'assistant' && <span className="chip ml-1.5 bg-accent-50 text-accent-700"><SparkleIcon className="h-3 w-3" /> Assistant</span>}
                          <span className="block text-xs text-slate-400">{[ev.location, ev.attendees.join(', ')].filter(Boolean).join(' · ')}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
