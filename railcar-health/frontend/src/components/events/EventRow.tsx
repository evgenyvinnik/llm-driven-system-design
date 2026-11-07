/**
 * One event: global position, event time vs recorded time, type and schema
 * version, stream and per-stream version, the summary, and its lineage
 * (correlation colour, link to the event that caused it).
 */
import { LinkIcon } from '@/components/icons'
import { clockText, correlationStyle, durationText, familyStyle, lagSeconds, streamLabel } from '@/lib/events'
import type { StoredEvent } from '@/types'

interface Props {
  event: StoredEvent
  selected: boolean
  causeType: string | null
  onSelect: (eventId: string) => void
}

export function EventRow({ event: e, selected, causeType, onSelect }: Props) {
  const lag = lagSeconds(e)
  return (
    <li
      id={`ev-${e.eventId}`}
      onClick={() => onSelect(e.eventId)}
      className={`grid cursor-pointer grid-cols-[64px_150px_1fr] gap-3 px-4 py-2.5 hover:bg-slate-50 ${selected ? 'bg-accent-50 ring-1 ring-inset ring-accent-200' : ''}`}
    >
      <div className="pt-0.5 font-mono text-xs text-slate-400">#{e.globalPosition}</div>
      <div className="text-xs leading-5">
        <div className="text-slate-800" title="Event time: when it happened">{clockText(e.occurredAt)}</div>
        <div className="text-slate-400" title="Recorded (processing) time: when the system learned it">rec. {clockText(e.recordedAt)}</div>
        {lag >= 60 && <span className="chip mt-0.5 bg-violet-50 text-violet-800 ring-1 ring-violet-200">learned {durationText(lag)} later</span>}
      </div>
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`chip ring-1 ${familyStyle(e.family)}`}>{e.type}</span>
          <span className={`chip ${e.upcast ? 'bg-amber-100 text-amber-900' : 'bg-slate-100 text-slate-600'}`} title={e.upcast ? `Stored at schema v${e.storedVersion}, upcast on read` : 'Schema version'}>
            {e.upcast ? `v${e.storedVersion}→v${e.version}` : `v${e.version}`}
          </span>
          <span className="font-mono text-[11px] text-slate-500">{streamLabel(e)}</span>
          <span className="text-[11px] text-slate-400">· {e.actor}</span>
        </div>
        <p className="text-sm text-slate-700">{e.summary}</p>
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className={`rounded px-1.5 py-0.5 font-mono ${correlationStyle(e.correlationId)}`} title="Correlation id: the business flow this event belongs to">{e.correlationId.length > 42 ? `${e.correlationId.slice(0, 42)}…` : e.correlationId}</span>
          {e.causationId && (
            <button type="button" className="inline-flex items-center gap-1 text-accent-700 hover:underline" onClick={(ev) => { ev.stopPropagation(); onSelect(e.causationId!) }} title="Causation: the event that directly caused this one">
              <LinkIcon className="h-3 w-3" /> caused by {causeType ?? 'an earlier event'}
            </button>
          )}
        </div>
      </div>
    </li>
  )
}
