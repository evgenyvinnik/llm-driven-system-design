import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { PlusIcon } from '@/components/icons'
import { RequireAuth } from '@/components/layout'
import { NewPresetForm, PresetEditor } from '@/components/presets'
import { ErrorNote, Loading } from '@/components/shared'
import { useCatalog } from '@/stores/catalog-store'

export const Route = createFileRoute('/presets')({
  component: () => (
    <RequireAuth>
      <PresetsPage />
    </RequireAuth>
  ),
})

function PresetsPage() {
  const presets = useCatalog((s) => s.presets)
  const loadPresets = useCatalog((s) => s.loadPresets)
  const loadModels = useCatalog((s) => s.loadModels)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    Promise.all([loadModels(), loadPresets()])
      .then(() => setLoaded(true))
      .catch((err: Error) => setError(err.message))
  }, [loadModels, loadPresets])

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Model presets</h1>
          <p className="text-sm text-slate-500">
            Shared with your workspace. Edits are checked against the revision you loaded, so nobody overwrites a teammate’s change by accident.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setCreating(true)}>
          <PlusIcon /> New preset
        </button>
      </div>
      {error && <ErrorNote message={error} />}
      {!loaded && !error ? (
        <Loading />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {creating && <NewPresetForm onDone={() => setCreating(false)} />}
          {presets.map((preset) => (
            <PresetEditor key={`${preset.id}:${preset.revision}`} preset={preset} />
          ))}
        </div>
      )}
    </main>
  )
}
