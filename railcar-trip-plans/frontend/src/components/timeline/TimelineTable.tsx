import { fmtClock, fmtLag } from '@/lib/format'
import { KIND, kindOf } from '@/lib/timeline'
import type { TimelineEvent } from '@/types'

interface Props {
  events: TimelineEvent[]
  selected: string | null
  onSelect: (id: string) => void
}

/** Every event about the car: event time vs recorded time, lateness, arrival order, schema version, cause. */
export function TimelineTable({ events, selected, onSelect }: Props) {
  return (
    <table className="w-full" aria-label="Event timeline">
      <thead className="sticky top-0 border-b border-slate-200 bg-slate-50">
        <tr>
          <th className="th">#</th>
          <th className="th">Event time / recorded</th>
          <th className="th">Event · producer</th>
          <th className="th w-1/2">What happened</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {events.map((e) => (
          <tr key={e.eventId} onClick={() => onSelect(e.eventId)} className={`cursor-pointer ${selected === e.eventId ? 'bg-accent-50' : 'hover:bg-slate-50'}`}>
            <td className="td mono text-slate-400">{e.position}</td>
            <td className="td whitespace-nowrap">
              <div className="mono text-slate-800">{fmtClock(e.occurredAt)}</div>
              <div className="mono text-slate-400">{fmtClock(e.recordedAt)}</div>
              <div className="flex gap-1">
                {e.late && <span className="chip bg-red-50 text-red-700" title="Recorded long after it happened">late {fmtLag(e.lagMinutes)}</span>}
                {e.outOfOrder && <span className="chip bg-amber-50 text-amber-800" title="Arrived after an event about this car that happened later">out of order</span>}
              </div>
            </td>
            <td className="td whitespace-nowrap">
              <span className={`chip ${KIND[kindOf(e)]}`}>{e.type}</span>
              <span className="ml-1 text-[11px] text-slate-500" title={e.upcastFrom ? `Stored as v${e.upcastFrom}, read through the upcaster` : undefined}>
                v{e.version}
                {e.upcastFrom ? ` ← v${e.upcastFrom}` : ''}
              </span>
              <div className="mono text-slate-400">{e.producer}</div>
            </td>
            <td className="td text-sm">
              {e.summary}
              {e.causationId && <span className="ml-1 text-[11px] text-slate-400">· caused by #{events.find((x) => x.eventId === e.causationId)?.position ?? '…'}</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
