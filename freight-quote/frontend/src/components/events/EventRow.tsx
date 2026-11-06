import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { ChevronRightIcon } from '@/components/icons'
import { dateTime, shortId } from '@/lib/format'
import type { StoredEvent } from '@/types'

export function EventRow({ event: e }: { event: StoredEvent }) {
  const [open, setOpen] = useState(false)
  const quoteId = e.stream_id.startsWith('quote-') ? e.stream_id.slice(6) : null
  const lagMs = new Date(e.recorded_at).getTime() - new Date(e.occurred_at).getTime()
  const old = e.latestVersion !== null && e.latestVersion !== undefined && e.version < e.latestVersion
  return (
    <>
      <tr className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(!open)}>
        <td className="td font-mono text-xs text-slate-500">
          <ChevronRightIcon className={`mr-1 inline h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`} />
          {e.position}
        </td>
        <td className="td">
          <span className="font-medium text-slate-900">{e.type}</span>{' '}
          <span className={`chip font-mono ${old ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'}`} title={old ? `stored as v${e.version}; consumers read it upcast to v${e.latestVersion}` : undefined}>
            v{e.version}
            {old ? ` → v${e.latestVersion}` : ''}
          </span>
        </td>
        <td className="td font-mono text-xs">
          {quoteId ? (
            <Link to="/quotes/$quoteId" params={{ quoteId }} className="text-accent-700 hover:underline" onClick={(ev) => ev.stopPropagation()}>
              quote-{shortId(quoteId)}
            </Link>
          ) : (
            e.stream_id
          )}
          <span className="text-slate-400"> #{e.stream_version}</span>
        </td>
        <td className="td text-xs text-slate-500">{dateTime(e.occurred_at)}</td>
        <td className="td text-xs text-slate-500">{lagMs > 1500 ? `+${(lagMs / 1000).toFixed(1)} s` : `+${lagMs} ms`}</td>
        <td className="td text-xs text-slate-500">{e.producer}</td>
        <td className="td font-mono text-xs text-slate-400">{e.correlation_id}</td>
        <td className="td text-xs">{e.published_at ? <span className="text-emerald-700">published</span> : <span className="text-amber-700">in outbox</span>}</td>
      </tr>
      {open && (
        <tr className="bg-slate-50">
          <td colSpan={8} className="px-4 py-3">
            <div className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <div className="mb-1 font-semibold text-slate-600">Envelope</div>
                <pre className="overflow-x-auto rounded bg-white p-2 text-[11px] text-slate-700 ring-1 ring-slate-200">
                  {JSON.stringify({ event_id: e.event_id, causation_id: e.causation_id, occurred_at: e.occurred_at, recorded_at: e.recorded_at, published_at: e.published_at }, null, 2)}
                </pre>
                <div className="mb-1 mt-2 font-semibold text-slate-600">Payload as stored (v{e.version})</div>
                <pre className="max-h-72 overflow-auto rounded bg-white p-2 text-[11px] text-slate-700 ring-1 ring-slate-200">{JSON.stringify(e.payload, null, 2)}</pre>
              </div>
              {e.upcastPayload && (
                <div>
                  <div className="mb-1 font-semibold text-amber-700">As consumers read it (upcast to v{e.latestVersion})</div>
                  <pre className="max-h-96 overflow-auto rounded bg-white p-2 text-[11px] text-slate-700 ring-1 ring-amber-200">{JSON.stringify(e.upcastPayload, null, 2)}</pre>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
