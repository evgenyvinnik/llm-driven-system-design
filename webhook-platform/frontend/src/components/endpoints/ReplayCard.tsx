import { useState } from 'react'
import { ReplayIcon } from '@/components/icons'
import { ErrorNote } from '@/components/shared/Loading'
import { api } from '@/services/api'
import type { Endpoint } from '@/types'

function localInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "Replay all failed since T": new attempts for the same event ids, never new events. */
export function ReplayCard({ endpoint: e, onReplayed }: { endpoint: Endpoint; onReplayed: () => void }) {
  const [since, setSince] = useState(() => localInputValue(new Date(Date.now() - 3600_000)))
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function replay() {
    setError(null)
    setResult(null)
    try {
      const r = await api.replayFailed(e.id, new Date(since).toISOString())
      setResult(r.replayed === 0 ? 'No failed deliveries in that window' : `Re-queued ${r.replayed} failed deliver${r.replayed === 1 ? 'y' : 'ies'}`)
      onReplayed()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Replay failed')
    }
  }

  return (
    <section className="card space-y-3 p-4">
      <h2 className="panel-title flex items-center gap-1.5"><ReplayIcon className="h-3.5 w-3.5" /> Replay failed</h2>
      <p className="text-xs text-slate-500">
        Re-sends failed deliveries with the <strong>same event id</strong>, so a receiver that dedupes by <span className="code">Webhook-Id</span> won&apos;t apply anything twice.
      </p>
      <div className="flex items-end gap-2">
        <div>
          <label className="label" htmlFor="since">Failed since</label>
          <input id="since" type="datetime-local" className="input" value={since} onChange={(ev) => setSince(ev.target.value)} />
        </div>
        <button type="button" className="btn-secondary" disabled={e.status !== 'active'} onClick={() => void replay()} title={e.status !== 'active' ? 'Re-enable the endpoint first' : undefined}>
          Replay ({e.health.failed} failed)
        </button>
      </div>
      {result && <p className="text-xs text-emerald-700">{result}</p>}
      {error && <ErrorNote message={error} />}
    </section>
  )
}
