import { useState, type FormEvent } from 'react'
import { ConfigCard } from '@/components/playground/ConfigCard'
import { ErrorNote } from '@/components/shared'
import { api, ApiError } from '@/services/api'
import { useCatalog } from '@/stores/catalog-store'
import { DEFAULT_CONFIG } from '@/stores/drafts-store'
import type { ModelConfig } from '@/types'

export function NewPresetForm({ onDone }: { onDone: () => void }) {
  const models = useCatalog((s) => s.models)
  const replacePreset = useCatalog((s) => s.replacePreset)
  const [name, setName] = useState('')
  const [config, setConfig] = useState<ModelConfig>(DEFAULT_CONFIG)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    try {
      const { preset } = await api.createPreset({ name: name.trim(), config })
      replacePreset(preset)
      onDone()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the preset')
    }
  }

  return (
    <form onSubmit={submit} className="card flex flex-col gap-3 border-accent-200 p-4">
      <input className="input font-medium" placeholder="Preset name" value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
      <ConfigCard config={config} models={models} presets={[]} onChange={setConfig} />
      {error && <ErrorNote message={error} />}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost py-1 text-xs" onClick={onDone}>
          Cancel
        </button>
        <button className="btn-primary py-1 text-xs" disabled={!name.trim()}>
          Create preset
        </button>
      </div>
    </form>
  )
}
