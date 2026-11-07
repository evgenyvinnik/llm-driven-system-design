import { useState } from 'react'
import { ErrorNote } from '@/components/shared/Loading'
import { api } from '@/services/api'
import type { DatasetCase } from '@/types'

/**
 * Edits the full case list as JSON and submits it against the version it
 * started from. If someone else saved a version meanwhile, the server answers
 * 409 instead of overwriting their change.
 */
export function NewVersionEditor({ datasetId, baseVersion: initialBase, cases, onSaved, onCancel }: { datasetId: string; baseVersion: number; cases: DatasetCase[]; onSaved: (version: number) => void; onCancel: () => void }) {
  // The version this edit started from, fixed for the editor's lifetime.
  const [baseVersion] = useState(initialBase)
  const [text, setText] = useState(() => JSON.stringify(cases.map((c) => ({ caseKey: c.caseKey, input: c.input, reference: c.reference, tags: c.tags })), null, 2))
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const parsed = JSON.parse(text)
      const r = await api.createDatasetVersion(datasetId, { baseVersion, message, cases: parsed })
      onSaved(r.version)
    } catch (err) {
      setError(err instanceof SyntaxError ? `Invalid JSON: ${err.message}` : err instanceof Error ? err.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card space-y-3 p-4">
      <div className="text-sm text-slate-600">
        Editing creates <b>v{baseVersion + 1}</b>. Cases without a <code className="code">caseKey</code> get a new key; v{baseVersion} stays exactly as it is.
      </div>
      <textarea className="input h-80 font-mono text-[11px]" value={text} onChange={(e) => setText(e.target.value)} aria-label="Cases JSON" spellCheck={false} />
      <input className="input" placeholder="What changed and why (required)" value={message} onChange={(e) => setMessage(e.target.value)} />
      {error && <ErrorNote message={error} />}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn-primary" disabled={busy || message.trim() === ''} onClick={() => void save()}>
          Save as v{baseVersion + 1}
        </button>
      </div>
    </div>
  )
}
