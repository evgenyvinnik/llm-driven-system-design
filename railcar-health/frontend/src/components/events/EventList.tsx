/** The timeline list with per-family filters. Events are in global-position (commit) order. */
import { useMemo, useState } from 'react'
import { FAMILY_GROUPS, familyGroup } from '@/lib/events'
import type { StoredEvent } from '@/types'
import { EventRow } from './EventRow'

export function EventList({ events, selected, onSelect }: { events: StoredEvent[]; selected: string | null; onSelect: (id: string) => void }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const byId = useMemo(() => new Map(events.map((e) => [e.eventId, e])), [events])
  const counts = useMemo(() => {
    const out = new Map<string, number>()
    for (const e of events) out.set(familyGroup(e.family)[0], (out.get(familyGroup(e.family)[0]) ?? 0) + 1)
    return out
  }, [events])
  const visible = events.filter((e) => !hidden.has(familyGroup(e.family)[0]))
  const toggle = (prefix: string) =>
    setHidden((h) => {
      const next = new Set(h)
      if (next.has(prefix)) next.delete(prefix)
      else next.add(prefix)
      return next
    })
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-100 px-4 py-2">
        <span className="panel-title mr-1">Families</span>
        {FAMILY_GROUPS.filter((g) => counts.has(g.prefix)).map((g) => (
          <button key={g.prefix} type="button" onClick={() => toggle(g.prefix)} className={`chip ring-1 ${hidden.has(g.prefix) ? 'bg-white text-slate-400 ring-slate-200 line-through' : 'bg-slate-800 text-white ring-slate-800'}`}>
            {g.label} {counts.get(g.prefix)}
          </button>
        ))}
        <span className="ml-auto text-xs text-slate-500">{visible.length} of {events.length} events</span>
      </div>
      <ol className="divide-y divide-slate-100" aria-label="Event timeline">
        {visible.map((e) => (
          <EventRow key={e.eventId} event={e} selected={selected === e.eventId} causeType={e.causationId ? (byId.get(e.causationId)?.type ?? e.causeType) : null} onSelect={onSelect} />
        ))}
      </ol>
      {visible.length === 0 && <p className="px-4 py-8 text-center text-sm text-slate-500">No events.</p>}
    </div>
  )
}
