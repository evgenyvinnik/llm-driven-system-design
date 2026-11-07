/**
 * The selected event: its full envelope, its payload (and the stored payload if
 * it was upcast from an older schema version), and its causation chain from the
 * root cause down to the events it caused.
 */
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { clockText, durationText, familyStyle, lagSeconds, shortId, streamLabel } from '@/lib/events'
import { useFetch } from '@/lib/hooks'
import { api } from '@/services/api'
import type { StoredEvent } from '@/types'
import { PayloadView } from './PayloadView'

function ChainItem({ e, current, onSelect }: { e: StoredEvent; current?: boolean; onSelect: (id: string) => void }) {
  return (
    <li>
      <button type="button" disabled={current} onClick={() => onSelect(e.eventId)} className={`w-full rounded px-2 py-1 text-left text-xs ${current ? 'bg-accent-50 font-semibold text-slate-900' : 'hover:bg-slate-50'}`}>
        <span className={`chip mr-1 ring-1 ${familyStyle(e.family)}`}>{e.type}</span>
        <span className="font-mono text-slate-500">#{e.globalPosition}</span> <span className="text-slate-600">{e.summary.slice(0, 70)}</span>
      </button>
    </li>
  )
}

const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="grid grid-cols-[110px_1fr] gap-2 py-0.5"><dt className="text-slate-500">{k}</dt><dd className="break-all font-mono text-slate-800">{v}</dd></div>
)

export function EventDetailPanel({ eventId, onSelect }: { eventId: string; onSelect: (id: string) => void }) {
  const { data, error } = useFetch(() => api.event(eventId), [eventId])
  if (error) return <ErrorNote message={error} />
  if (!data || data.event.eventId !== eventId) return <Loading />
  const e = data.event
  const lag = lagSeconds(e)
  return (
    <div className="space-y-4">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`chip ring-1 ${familyStyle(e.family)}`}>{e.type}</span>
          <span className="text-xs text-slate-500">{streamLabel(e)}</span>
        </div>
        <p className="mt-1 text-sm text-slate-700">{e.summary}</p>
      </div>
      <dl className="text-xs">
        <Row k="event_id" v={e.eventId} />
        <Row k="schema" v={e.upcast ? `stored v${e.storedVersion}, read as v${e.version} (upcast)` : `v${e.version}`} />
        <Row k="stream" v={`${e.streamId} @ version ${e.streamVersion}`} />
        <Row k="position" v={`#${e.globalPosition} (global)`} />
        <Row k="topic / key" v={`${e.family} / ${e.partitionKey}`} />
        <Row k="occurred_at" v={`${clockText(e.occurredAt)} (event time)`} />
        <Row k="recorded_at" v={`${clockText(e.recordedAt)}${lag >= 60 ? ` (${durationText(lag)} after it happened)` : ''}`} />
        <Row k="correlation" v={`${e.correlationId} (${data.correlatedCount} events in this flow)`} />
        <Row k="causation" v={e.causationId ? shortId(e.causationId) : 'none (a root event)'} />
        <Row k="actor" v={e.actor} />
        <Row k="tags" v={e.tags.join(', ') || '—'} />
      </dl>
      <div>
        <div className="panel-title mb-1">Causation chain</div>
        <ol className="space-y-0.5 border-l-2 border-slate-200 pl-2">
          {data.ancestors.map((a) => <ChainItem key={a.eventId} e={a} onSelect={onSelect} />)}
          <ChainItem e={e} current onSelect={onSelect} />
          {data.children.map((c) => <ChainItem key={c.eventId} e={c} onSelect={onSelect} />)}
        </ol>
        {data.children.length > 0 && <p className="mt-1 text-[11px] text-slate-500">The last {data.children.length} item(s) were caused by this event.</p>}
      </div>
      <PayloadView label={e.upcast ? `Payload (as read, v${e.version})` : 'Payload'} value={e.payload} />
      {e.upcast && <PayloadView label={`Payload as stored (v${data.stored.version})`} value={data.stored.payload} />}
    </div>
  )
}
