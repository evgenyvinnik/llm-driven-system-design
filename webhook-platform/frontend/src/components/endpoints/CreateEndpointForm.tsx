import { useState, type FormEvent } from 'react'
import { CopyIcon, PlusIcon } from '@/components/icons'
import { ErrorNote } from '@/components/shared/Loading'
import { api } from '@/services/api'

export function CreateEndpointForm({ receiverUrl, onCreated }: { receiverUrl: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState(`${receiverUrl}/hooks/acme-new`)
  const [description, setDescription] = useState('')
  const [types, setTypes] = useState('*')
  const [concurrency, setConcurrency] = useState(4)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<{ secret: string; warning: string | null } | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      const eventTypes = types.split(',').map((t) => t.trim()).filter(Boolean)
      const res = await api.createEndpoint({ url, description, eventTypes, maxConcurrency: concurrency })
      setCreated({ secret: res.secret, warning: res.warning })
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the endpoint')
    }
  }

  if (!open) {
    return (
      <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
        <PlusIcon /> New endpoint
      </button>
    )
  }
  return (
    <form onSubmit={submit} className="card space-y-3 p-4">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="md:col-span-2">
          <label className="label" htmlFor="ep-url">URL</label>
          <input id="ep-url" className="input font-mono" value={url} onChange={(e) => setUrl(e.target.value)} />
          <p className="mt-1 text-xs text-slate-500">Private, loopback, link-local and metadata addresses are refused, here and again on every delivery. Locally only the mock receiver is allowlisted.</p>
        </div>
        <div>
          <label className="label" htmlFor="ep-desc">Description</label>
          <input id="ep-desc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Shipping service" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="ep-types">Event types</label>
            <input id="ep-types" className="input font-mono" value={types} onChange={(e) => setTypes(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="ep-conc">Max in flight</label>
            <input id="ep-conc" type="number" min={1} max={32} className="input" value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} />
          </div>
        </div>
      </div>
      {error && <ErrorNote message={error} />}
      {created && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          Created. Signing secret (shown once here; you can reveal it later on the endpoint page):
          <div className="mt-1 flex items-center gap-2 font-mono text-xs">
            {created.secret}
            <button type="button" className="btn-ghost px-1.5 py-0.5" onClick={() => void navigator.clipboard?.writeText(created.secret)} title="Copy">
              <CopyIcon className="h-3.5 w-3.5" />
            </button>
          </div>
          {created.warning && <p className="mt-1 text-amber-800">{created.warning}</p>}
        </div>
      )}
      <div className="flex gap-2">
        <button type="submit" className="btn-primary">Create endpoint</button>
        <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Close</button>
      </div>
    </form>
  )
}
