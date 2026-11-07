import { useNavigate } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { api, ApiError, type NewFlag } from '@/services/api'

export function NewFlagForm({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const [form, setForm] = useState<NewFlag>({ key: '', kind: 'experiment', name: '', description: '', unitType: 'user', primaryMetric: 'purchase', surface: '' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof NewFlag>(k: K, v: NewFlag[K]) => setForm((f) => ({ ...f, [k]: v }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { flag } = await api.createFlag(form)
      void navigate({ to: '/flags/$key', params: { key: flag.key } })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create')
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="card grid grid-cols-6 gap-3 p-4" aria-label="New flag or experiment">
      <div className="col-span-2">
        <label className="label" htmlFor="nf-key">Key</label>
        <input id="nf-key" className="input font-mono" placeholder="pricing_page_layout" value={form.key} onChange={(e) => set('key', e.target.value)} required />
      </div>
      <div className="col-span-2">
        <label className="label" htmlFor="nf-name">Name</label>
        <input id="nf-name" className="input" value={form.name} onChange={(e) => set('name', e.target.value)} required />
      </div>
      <div>
        <label className="label" htmlFor="nf-kind">Kind</label>
        <select id="nf-kind" className="input" value={form.kind} onChange={(e) => set('kind', e.target.value as NewFlag['kind'])}>
          <option value="experiment">experiment</option>
          <option value="flag">flag</option>
        </select>
      </div>
      <div>
        <label className="label" htmlFor="nf-unit">Unit</label>
        <select id="nf-unit" className="input" value={form.unitType} onChange={(e) => set('unitType', e.target.value as NewFlag['unitType'])}>
          <option value="user">user</option>
          <option value="org">org</option>
          <option value="anonymous">anonymous</option>
        </select>
      </div>
      <div className="col-span-3">
        <label className="label" htmlFor="nf-surface">Where it renders</label>
        <input id="nf-surface" className="input" placeholder="Pricing page hero" value={form.surface} onChange={(e) => set('surface', e.target.value)} />
      </div>
      <div className="col-span-2">
        <label className="label" htmlFor="nf-metric">Primary metric (event)</label>
        <input id="nf-metric" className="input font-mono" value={form.primaryMetric} onChange={(e) => set('primaryMetric', e.target.value)} />
      </div>
      <div className="col-span-1 flex items-end gap-2">
        <button type="submit" className="btn-primary" disabled={busy}>
          Create
        </button>
        <button type="button" className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
      <p className="col-span-6 text-xs text-slate-500">
        Created as a draft in every environment with a random salt. Experiments start at an even control/treatment split, flags at 0% on.
        {error && <span className="ml-2 font-medium text-rose-700">{error}</span>}
      </p>
    </form>
  )
}
