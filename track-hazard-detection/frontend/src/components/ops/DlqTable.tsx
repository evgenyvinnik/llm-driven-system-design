import { useState } from 'react'
import { PlayIcon, TrashIcon } from '@/components/icons'
import { Empty } from '@/components/shared/Loading'
import { timeText } from '@/lib/format'
import { api } from '@/services/api'
import type { DeadLetter } from '@/types'

/** Dead letters with redrive (re-publish unchanged; idempotent consumers make it safe) and discard. */
export function DlqTable({ rows, canAct, onDone }: { rows: DeadLetter[]; canAct: boolean; onDone: () => void }) {
  const [msg, setMsg] = useState<string | null>(null)
  async function act(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn()
      setMsg(ok)
      onDone()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Failed')
    }
  }
  if (rows.length === 0) return <Empty>The dead-letter queue is empty.</Empty>
  return (
    <div>
      {msg && <p className="mx-4 mt-3 rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-700">{msg}</p>}
      <table className="min-w-full" aria-label="Dead letters">
        <thead className="bg-slate-50">
          <tr>
            <th className="th">Failed</th>
            <th className="th">Group</th>
            <th className="th">Event</th>
            <th className="th">Error</th>
            <th className="th">Tries</th>
            <th className="th">Status</th>
            <th className="th" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((d) => {
            const env = typeof d.event === 'object' ? d.event : null
            const sensorId = env ? String((env.payload as { sensorId?: string }).sensorId ?? '') : ''
            return (
              <tr key={d.id} className={d.status === 'dead' ? '' : 'text-slate-400'}>
                <td className="td text-xs">{timeText(d.failedAt)}</td>
                <td className="td">{d.group}</td>
                <td className="td text-xs">
                  <div className="font-medium text-slate-800">{d.type} v{env?.version ?? '?'}</div>
                  <div className="font-mono">{env?.source} · {sensorId} · {d.key}</div>
                </td>
                <td className="td max-w-md text-xs">
                  <span className={`chip mr-1 ${d.permanent ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}`}>{d.code}</span>
                  {d.error}
                </td>
                <td className="td">{d.deliveries}</td>
                <td className="td text-xs">{d.status === 'dead' ? <span className="font-semibold text-red-700">dead</span> : `${d.status} by ${d.resolvedBy}`}</td>
                <td className="td whitespace-nowrap text-right">
                  {canAct && d.status === 'dead' && (
                    <span className="inline-flex gap-1">
                      {d.code === 'UNKNOWN_SENSOR' && sensorId && (
                        <button type="button" className="btn-secondary" onClick={() => void act(() => api.registerSensor({ id: sensorId, type: 'geophone', milepost: Number(sensorId.split('-')[1]) }), `Registered ${sensorId}; now redrive its dead letters.`)}>
                          Register sensor
                        </button>
                      )}
                      <button type="button" className="btn-secondary" onClick={() => void act(() => api.redrive(d.id), `Redriven to ${d.key}`)}>
                        <PlayIcon className="h-3.5 w-3.5" /> Redrive
                      </button>
                      <button type="button" className="btn-ghost" title="Discard" onClick={() => void act(() => api.discard(d.id), 'Discarded')}>
                        <TrashIcon className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
