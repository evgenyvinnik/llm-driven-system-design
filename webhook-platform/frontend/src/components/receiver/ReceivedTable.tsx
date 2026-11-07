import { Empty } from '@/components/shared/Loading'
import { shortId, time } from '@/lib/format'
import type { ReceivedEntry } from '@/types'

function Verdict({ e }: { e: ReceivedEntry }) {
  if (e.duplicate) return <span className="chip bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-200">Duplicate</span>
  if (e.stale) return <span className="chip bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-200">Stale (discarded)</span>
  if (e.signatureValid === false) return <span className="chip bg-red-50 text-red-700 ring-1 ring-inset ring-red-200">Bad signature</span>
  if (!e.processed) return <span className="chip bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200">Not processed</span>
  return <span className="chip bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200">Applied</span>
}

/** What the customer's server saw, newest first, with duplicates and stale updates flagged. */
export function ReceivedTable({ entries }: { entries: ReceivedEntry[] }) {
  if (entries.length === 0) return <Empty>Nothing received yet.</Empty>
  return (
    <div className="overflow-x-auto">
      <table className="w-full" aria-label="Received requests">
        <thead className="border-b border-slate-200 bg-slate-50">
          <tr>
            <th className="th">Time</th>
            <th className="th">Path</th>
            <th className="th">Event id (Webhook-Id)</th>
            <th className="th">Type</th>
            <th className="th">Attempt</th>
            <th className="th">Signature</th>
            <th className="th">Verdict</th>
            <th className="th">Answer</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {entries.map((e) => (
            <tr key={e.seq} className={e.duplicate ? 'bg-violet-50/40' : undefined}>
              <td className="td num text-xs text-slate-500">{time(e.receivedAt)}</td>
              <td className="td font-mono text-xs">{e.path}</td>
              <td className="td font-mono text-xs">{e.eventId ? shortId(e.eventId) : '—'}{e.orderingKey && <div className="text-[11px] text-slate-500">{e.orderingKey} #{e.sequence}</div>}</td>
              <td className="td font-mono text-xs">{e.type ?? '—'}</td>
              <td className="td num text-xs">{e.attempt ?? '—'}</td>
              <td className="td text-xs">
                {e.signatureValid === null ? <span className="text-slate-400">not checked</span> : e.signatureValid ? <span className="text-emerald-700">valid · {e.signatureReason}</span> : <span className="text-red-700">{e.signatureReason}</span>}
                {e.signaturesPresented > 1 && <div className="text-[11px] text-slate-500">{e.signaturesPresented} v1 signatures</div>}
              </td>
              <td className="td"><Verdict e={e} /><div className="mt-0.5 max-w-[220px] text-[11px] text-slate-500">{e.note}</div></td>
              <td className="td num font-mono text-xs">{e.responseStatus ?? <span className="text-slate-400">none</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
