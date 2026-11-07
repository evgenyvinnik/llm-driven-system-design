import { useState } from 'react'
import { ErrorNote } from '@/components/shared/Loading'
import { api } from '@/services/api'
import type { PromptVersion } from '@/types'

export function PromptEditor({ promptId, head, onSaved, onCancel }: { promptId: string; head: PromptVersion; onSaved: () => void; onCancel: () => void }) {
  // The base is the version this edit started from, captured once: a later poll must not move it.
  const [base] = useState(head.version)
  const [system, setSystem] = useState(head.system)
  const [template, setTemplate] = useState(head.template)
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  async function save() {
    setError(null)
    try {
      await api.createPromptVersion(promptId, { baseVersion: base, system, template, message })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    }
  }
  return (
    <div className="card space-y-3 p-4">
      <label className="block">
        <span className="label">System</span>
        <textarea className="input h-16 font-mono text-xs" value={system} onChange={(e) => setSystem(e.target.value)} />
      </label>
      <label className="block">
        <span className="label">Template ({'{{variable}}'} placeholders)</span>
        <textarea className="input h-48 font-mono text-xs" value={template} onChange={(e) => setTemplate(e.target.value)} />
      </label>
      <input className="input" placeholder="What changed (required)" value={message} onChange={(e) => setMessage(e.target.value)} />
      {error && <ErrorNote message={error} />}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn-primary" disabled={!message.trim()} onClick={() => void save()}>
          Save as v{base + 1}
        </button>
      </div>
    </div>
  )
}
