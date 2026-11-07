import { useState } from 'react'
import { ErrorNote } from '@/components/shared/Loading'
import { api } from '@/services/api'
import type { Endpoint } from '@/types'

/** Event-type filter and per-endpoint concurrency. */
export function EndpointSettings({ endpoint: e, onSaved }: { endpoint: Endpoint; onSaved: () => void }) {
  const [types, setTypes] = useState(e.eventTypes.join(', '))
  const [concurrency, setConcurrency] = useState(e.maxConcurrency)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setError(null)
    setMsg(null)
    try {
      await api.updateEndpoint(e.id, { eventTypes: types.split(',').map((t) => t.trim()).filter(Boolean), maxConcurrency: concurrency })
      setMsg('Saved')
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    }
  }

  return (
    <section className="card space-y-3 p-4">
      <h2 className="panel-title">Filter and limits</h2>
      <div>
        <label className="label" htmlFor="types">Event types</label>
        <input id="types" className="input font-mono" value={types} onChange={(ev) => setTypes(ev.target.value)} />
        <p className="mt-1 text-xs text-slate-500"><span className="code">*</span> for everything, <span className="code">order.*</span> for a family, or exact types. Comma-separated.</p>
      </div>
      <div>
        <label className="label" htmlFor="conc">Max requests in flight</label>
        <input id="conc" type="number" min={1} max={32} className="input w-28" value={concurrency} onChange={(ev) => setConcurrency(Number(ev.target.value))} />
        <p className="mt-1 text-xs text-slate-500">Across all workers. Extra work waits in the database, not in a worker, so a slow endpoint can't starve anyone else.</p>
      </div>
      {error && <ErrorNote message={error} />}
      <div className="flex items-center gap-2">
        <button type="button" className="btn-secondary" onClick={() => void save()}>Save</button>
        {msg && <span className="text-xs text-emerald-700">{msg}</span>}
      </div>
    </section>
  )
}
