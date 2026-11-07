import { useEffect, useState, type FormEvent } from 'react'
import { api } from '@/services/api'
import type { RuntimeConfig } from '@/types'

const FIELDS: { key: keyof RuntimeConfig; label: string; step?: number }[] = [
  { key: 'batchMaxSize', label: 'Batch size' },
  { key: 'interactiveMaxWaitMs', label: 'Interactive max wait (ms)' },
  { key: 'batchMaxWaitMs', label: 'Bulk max wait (ms)' },
  { key: 'interactiveQueueLimit', label: 'Interactive queue bound' },
  { key: 'batchQueueLimit', label: 'Bulk queue bound' },
  { key: 'batchMinShare', label: 'Bulk min share', step: 0.05 },
  { key: 'batchMaxShare', label: 'Bulk max share', step: 0.05 },
]

/** Live dispatcher knobs (stored in Valkey; every process picks them up within a second). */
export function ConfigPanel({ config, onChange }: { config: RuntimeConfig; onChange: () => void }) {
  const [draft, setDraft] = useState<RuntimeConfig>(config)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!dirty) setDraft(config)
  }, [config, dirty])

  async function save(e: FormEvent) {
    e.preventDefault()
    try {
      await api.setConfig(draft)
      setDirty(false)
      setError(null)
      onChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed')
    }
  }

  return (
    <form className="card p-4" onSubmit={save} aria-label="Dispatcher settings">
      <h2 className="panel-title">Dispatcher settings</h2>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {FIELDS.map((f) => (
          <div key={f.key}>
            <label className="label" htmlFor={`cfg-${f.key}`}>{f.label}</label>
            <input
              id={`cfg-${f.key}`}
              type="number"
              step={f.step ?? 1}
              className="input"
              value={draft[f.key]}
              onChange={(e) => {
                setDirty(true)
                setDraft({ ...draft, [f.key]: Number(e.target.value) })
              }}
            />
          </div>
        ))}
      </div>
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button type="submit" className="btn-primary btn-xs" disabled={!dirty}>Apply</button>
        <button
          type="button"
          className="btn-ghost btn-xs"
          onClick={async () => {
            await api.resetConfig()
            setDirty(false)
            onChange()
          }}
        >
          Reset to defaults
        </button>
      </div>
    </form>
  )
}
