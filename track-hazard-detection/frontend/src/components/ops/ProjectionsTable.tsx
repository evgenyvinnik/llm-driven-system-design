import { useState } from 'react'
import { ReplayIcon } from '@/components/icons'
import { dateTimeText, secondsText } from '@/lib/format'
import { api } from '@/services/api'
import type { OpsOverview, ReplayResult } from '@/types'

export function ProjectionsTable({ projections, canReplay, onDone }: { projections: OpsOverview['projections']; canReplay: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<ReplayResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  async function replay(name: string) {
    setBusy(name)
    setError(null)
    try {
      setResult(await api.replay(name))
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Replay failed')
    } finally {
      setBusy(null)
    }
  }
  return (
    <div>
      <table className="min-w-full" aria-label="Projections">
        <thead className="bg-slate-50">
          <tr>
            <th className="th">Projection</th>
            <th className="th">Events applied</th>
            <th className="th">Checkpoint</th>
            <th className="th">Staleness</th>
            <th className="th">Rebuilt</th>
            <th className="th" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {projections.map((p) => (
            <tr key={p.projection}>
              <td className="td font-medium">{p.projection}</td>
              <td className="td">{p.eventsApplied}</td>
              <td className="td font-mono text-xs">#{p.lastPosition}</td>
              <td className="td">{p.stalenessSeconds < 0.5 ? <span className="text-emerald-700">caught up</span> : secondsText(p.stalenessSeconds)}</td>
              <td className="td text-xs">{dateTimeText(p.rebuiltAt)}</td>
              <td className="td text-right">
                {canReplay && (
                  <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => void replay(p.projection)}>
                    <ReplayIcon /> {busy === p.projection ? 'Replaying…' : 'Replay from 0'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <p className="m-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {result && (
        <div className={`m-3 rounded-md px-3 py-2 text-sm ${result.match ? 'bg-emerald-50 text-emerald-900' : 'bg-amber-50 text-amber-900'}`} role="status">
          <b>{result.projection}</b>: replayed {result.eventsReplayed} events in {result.ms} ms. Live {result.before.rows} rows <code>{result.before.md5.slice(0, 10)}</code> · rebuilt {result.after.rows} rows <code>{result.after.md5.slice(0, 10)}</code> ·{' '}
          {result.match ? 'identical' : result.liveStreamsBehind ? `different: live was ${result.liveStreamsBehind} stream(s) behind` : 'different'}
        </div>
      )}
    </div>
  )
}
