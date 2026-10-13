import { useState } from 'react'
import { AlertIcon, TrashIcon } from '@/components/icons'
import { ConfigCard } from '@/components/playground/ConfigCard'
import { timeAgo } from '@/lib/format'
import { api, ApiError } from '@/services/api'
import { useCatalog } from '@/stores/catalog-store'
import type { ModelConfig, Preset } from '@/types'

/**
 * Edits one shared preset. Saves send the revision this editor loaded
 * (If-Match). If a teammate saved first, the server answers 409 with their
 * version and the editor asks which one to keep instead of overwriting.
 */
export function PresetEditor({ preset }: { preset: Preset }) {
  const models = useCatalog((s) => s.models)
  const replacePreset = useCatalog((s) => s.replacePreset)
  const removePreset = useCatalog((s) => s.removePreset)
  const [base, setBase] = useState(preset)
  const [name, setName] = useState(preset.name)
  const [config, setConfig] = useState<ModelConfig>(preset.config)
  const [conflict, setConflict] = useState<Preset | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const dirty = name !== base.name || JSON.stringify(config) !== JSON.stringify(base.config)

  async function save(revision: number) {
    setBusy(true)
    setError(null)
    try {
      const { preset: saved } = await api.updatePreset(base.id, revision, { name, config })
      setBase(saved)
      setConflict(null)
      replacePreset(saved)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'REVISION_CONFLICT') {
        setConflict((err.details as { current: Preset }).current)
      } else {
        setError(err instanceof ApiError ? err.message : 'Save failed')
      }
    } finally {
      setBusy(false)
    }
  }

  function acceptTheirs(theirs: Preset) {
    setBase(theirs)
    setName(theirs.name)
    setConfig(theirs.config)
    setConflict(null)
    replacePreset(theirs)
  }

  async function remove() {
    if (!window.confirm(`Delete preset “${base.name}” for everyone in the workspace?`)) return
    try {
      await api.deletePreset(base.id, base.revision)
      removePreset(base.id)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'REVISION_CONFLICT') setConflict((err.details as { current: Preset }).current)
      else setError(err instanceof ApiError ? err.message : 'Delete failed')
    }
  }

  return (
    <div className="card flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <input className="input font-medium" value={name} onChange={(e) => setName(e.target.value)} aria-label="Preset name" />
        <button className="btn-ghost px-2 text-red-600" onClick={() => void remove()} aria-label="Delete preset">
          <TrashIcon />
        </button>
      </div>
      <ConfigCard config={config} models={models} presets={[]} onChange={setConfig} />
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>
          rev {base.revision} · {base.updatedBy} · {timeAgo(base.updatedAt)}
        </span>
        <button className="btn-primary py-1 text-xs" disabled={!dirty || busy} onClick={() => void save(base.revision)}>
          Save
        </button>
      </div>
      {conflict && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          <div className="mb-2 flex items-center gap-1.5 font-semibold">
            <AlertIcon className="h-3.5 w-3.5" /> {conflict.updatedBy} changed this preset (rev {conflict.revision}) after you opened it
          </div>
          <div className="mb-2 grid grid-cols-2 gap-2 font-mono">
            <div>
              <div className="font-sans font-semibold">Theirs</div>
              {conflict.name} · {conflict.config.model} · t={conflict.config.temperature} · max {conflict.config.maxTokens}
            </div>
            <div>
              <div className="font-sans font-semibold">Yours</div>
              {name} · {config.model} · t={config.temperature} · max {config.maxTokens}
            </div>
          </div>
          <div className="flex gap-2">
            <button className="btn-secondary py-1 text-xs" onClick={() => acceptTheirs(conflict)}>
              Use theirs
            </button>
            <button className="btn-primary py-1 text-xs" onClick={() => void save(conflict.revision)}>
              Overwrite with mine
            </button>
          </div>
        </div>
      )}
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  )
}
