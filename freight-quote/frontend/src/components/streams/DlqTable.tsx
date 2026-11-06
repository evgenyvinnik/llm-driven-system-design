import { RefreshIcon, XIcon } from '@/components/icons'
import { dateTime } from '@/lib/format'
import { api } from '@/services/api'
import type { DeadLetter } from '@/types'

export function DlqTable({ letters, onChange }: { letters: DeadLetter[]; onChange: () => void }) {
  return (
    <section className="card overflow-hidden" aria-label="Dead-letter queue">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
        <div className="panel-title">Dead-letter stream fq:dlq ({letters.length})</div>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => void api.poison('unknown_version').then(onChange)}>
            Inject poison (unknown version)
          </button>
          <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => void api.poison('malformed').then(onChange)}>
            Inject malformed
          </button>
        </div>
      </div>
      {letters.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-slate-500">Empty. Poison messages land here at once; transient failures after 5 deliveries with backoff.</p>
      ) : (
        <table className="w-full" aria-label="Dead letters">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">Dead at</th>
              <th className="th">Group</th>
              <th className="th">Event</th>
              <th className="th">Reason</th>
              <th className="th text-right">Deliveries</th>
              <th className="th text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {letters.map((l) => (
              <tr key={l.id} className="align-top">
                <td className="td text-xs text-slate-500">{dateTime(l.deadAt)}</td>
                <td className="td font-mono text-xs">{l.group}</td>
                <td className="td text-xs">
                  <div className="font-medium">{l.eventType ?? 'unparseable'}</div>
                  <div className="font-mono text-[11px] text-slate-400">{l.sourceStream} {l.sourceId}</div>
                </td>
                <td className="td text-xs">
                  <span className={`chip ${l.reason === 'permanent' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}`}>{l.reason}</span>
                  <div className="mt-1 max-w-sm text-slate-600">{l.error}</div>
                </td>
                <td className="td text-right tabular-nums">{l.deliveries}</td>
                <td className="td text-right">
                  <div className="flex justify-end gap-1">
                    <button type="button" className="btn-secondary px-2 py-1 text-xs" title={`Re-queue to fq:redrive:${l.group} (only this group sees it)`} onClick={() => void api.redrive(l.id).then(onChange)}>
                      <RefreshIcon className="h-3.5 w-3.5" /> Redrive
                    </button>
                    <button type="button" className="btn-ghost px-2 py-1 text-xs" title="Discard" onClick={() => void api.discard(l.id).then(onChange)}>
                      <XIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
