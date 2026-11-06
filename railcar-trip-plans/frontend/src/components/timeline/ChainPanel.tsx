import { XIcon } from '@/components/icons'
import { Loading } from '@/components/shared/Loading'
import { fmtClock } from '@/lib/format'
import { usePoll } from '@/lib/hooks'
import { api } from '@/services/api'
import type { TimelineEvent } from '@/types'

function Node({ e, role }: { e: TimelineEvent; role: 'ancestor' | 'root' | 'descendant' }) {
  const ring = role === 'root' ? 'border-accent-500 bg-accent-50' : 'border-slate-200 bg-white'
  return (
    <li className={`rounded-md border p-2 ${ring}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-slate-800">{e.type}</span>
        <span className="mono text-slate-400">#{e.position}</span>
      </div>
      <p className="text-xs text-slate-600">{e.summary}</p>
      <p className="mono mt-0.5 text-slate-400">
        {e.producer} · {fmtClock(e.occurredAt)}
      </p>
    </li>
  )
}

/** The causation chain around one event: what caused it, and everything it caused. */
export function ChainPanel({ eventId, carId, onClose }: { eventId: string; carId: string; onClose: () => void }) {
  const { data, error } = usePoll(() => api.chain(eventId, carId), [eventId], 0)
  return (
    <aside className="card flex max-h-[calc(100vh-180px)] flex-col overflow-hidden" aria-label="Causation chain">
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
        <span className="panel-title">Causation chain</span>
        <button type="button" onClick={onClose} className="rounded p-1 hover:bg-slate-100" title="Close">
          <XIcon className="h-4 w-4" />
        </button>
      </div>
      <div className="overflow-y-auto p-3">
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!data ? (
          <Loading />
        ) : (
          <>
            <ol className="space-y-1.5">
              {data.ancestors.map((e) => <Node key={e.eventId} e={e} role="ancestor" />)}
              <Node e={data.root} role="root" />
              {data.descendants.map((e) => <Node key={e.eventId} e={e} role="descendant" />)}
            </ol>
            <p className="mt-3 text-[11px] text-slate-500">
              correlation <span className="font-mono">{data.root.correlationId.slice(0, 8)}</span> · stream <span className="font-mono">{data.root.streamId}</span> v{data.root.streamVersion}
            </p>
            <pre className="mono mt-2 max-h-64 overflow-auto rounded bg-slate-900 p-2 text-[11px] text-slate-100">{JSON.stringify(data.root.payload, null, 2)}</pre>
          </>
        )}
      </div>
    </aside>
  )
}
