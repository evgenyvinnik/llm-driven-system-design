import { useEffect, useState } from 'react'
import { relativeTime } from '@/lib/format'
import { api } from '@/services/api'
import type { IndexStatus } from '@/types'

/** Retrieval index health: pending events per lane (permissions first), chunk counts, last write. */
export function IndexPanel() {
  const [status, setStatus] = useState<IndexStatus | null>(null)
  const [queued, setQueued] = useState<number | null>(null)
  useEffect(() => {
    const load = () => api.adminIndex().then((r) => setStatus(r.index)).catch(() => undefined)
    void load()
    const timer = setInterval(load, 3000)
    return () => clearInterval(timer)
  }, [])
  if (!status) return null
  return (
    <div className="card space-y-2 p-3">
      <div className="panel-title">Retrieval index</div>
      <table className="w-full text-xs">
        <tbody>
          {status.pending.map((p) => (
            <tr key={p.lane}>
              <td className="py-0.5 text-slate-600">{p.lane}</td>
              <td className="text-right tabular-nums text-slate-900">{p.count} pending</td>
              <td className="w-20 text-right text-slate-400">{p.oldestSeconds !== null ? `${p.oldestSeconds.toFixed(1)}s old` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="text-xs text-slate-600">
        {status.chunks.map((c) => `${c.count} ${c.sourceType} chunks`).join(' · ')}
        {status.lastIndexedAt && <span className="text-slate-400"> · last write {relativeTime(status.lastIndexedAt)}</span>}
        {status.failed > 0 && <span className="text-red-600"> · {status.failed} failed</span>}
      </div>
      <button type="button" className="btn-secondary text-xs" onClick={() => api.adminBackfill().then((r) => setQueued(r.queued))}>Re-index everything (backfill lane)</button>
      {queued !== null && <span className="ml-2 text-xs text-slate-500">{queued} queued</span>}
    </div>
  )
}
