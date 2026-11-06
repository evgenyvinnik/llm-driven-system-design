import { Fragment, useState } from 'react'
import { msText, timeText } from '@/lib/format'
import type { Envelope } from '@/types'
import { summarize } from './summarize'

const ACTOR_CLASS: Record<string, string> = { correlator: 'bg-violet-100 text-violet-800', alerting: 'bg-amber-100 text-amber-800', api: 'bg-sky-100 text-sky-800' }

/** The hazard's event stream, in stream-version order: the audit trail and the source of every projection. */
export function Timeline({ events }: { events: Envelope[] }) {
  const [open, setOpen] = useState<string | null>(null)
  const byId = new Map(events.map((e) => [e.eventId, e]))
  return (
    <table className="min-w-full" aria-label="Event timeline">
      <thead className="bg-slate-50">
        <tr>
          <th className="th">v</th>
          <th className="th">Event</th>
          <th className="th">Occurred</th>
          <th className="th">Recorded</th>
          <th className="th">By</th>
          <th className="th">Caused by</th>
          <th className="th">Detail</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {events.map((e) => {
          const actor = String(e.meta.actor ?? e.source)
          const cause = e.causationId ? byId.get(e.causationId) : undefined
          return (
            <Fragment key={e.eventId}>
              <tr className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(open === e.eventId ? null : e.eventId)}>
                <td className="td font-mono text-xs text-slate-400">{e.streamVersion}</td>
                <td className="td whitespace-nowrap font-medium text-slate-900">{e.type}</td>
                <td className="td whitespace-nowrap text-xs">{timeText(e.occurredAt)}</td>
                <td className="td whitespace-nowrap text-xs">
                  {timeText(e.recordedAt)}
                  {Date.parse(e.recordedAt) - Date.parse(e.occurredAt) >= 1 && <span className="text-slate-400"> +{msText(Date.parse(e.recordedAt) - Date.parse(e.occurredAt))}</span>}
                </td>
                <td className="td">
                  <span className={`chip ${ACTOR_CLASS[e.source] ?? 'bg-slate-100 text-slate-700'}`}>{actor}</span>
                </td>
                <td className="td font-mono text-xs text-slate-500">{cause ? `v${cause.streamVersion} ${cause.type}` : e.causationId ? `${e.causationId.slice(0, 8)} (edge/train event)` : 'timer / none'}</td>
                <td className="td text-xs text-slate-600">{summarize(e)}</td>
              </tr>
              {open === e.eventId && (
                <tr>
                  <td colSpan={7} className="bg-slate-50 px-3 py-2">
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-slate-700">{JSON.stringify(e, null, 2)}</pre>
                  </td>
                </tr>
              )}
            </Fragment>
          )
        })}
      </tbody>
    </table>
  )
}
