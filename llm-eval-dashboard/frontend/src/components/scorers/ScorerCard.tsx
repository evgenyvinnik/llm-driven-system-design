import { useState } from 'react'
import { ErrorNote } from '@/components/shared/Loading'
import { ago } from '@/lib/format'
import { api } from '@/services/api'
import type { Scorer } from '@/types'

const KIND_LABEL: Record<string, string> = { exact_match: 'exact match', regex: 'regex', contains: 'contains', json_shape: 'JSON shape', model_graded: 'model-graded (mock judge)', human: 'human' }

/** Scorer versions are immutable; a fix is a new version, applied to old runs by re-scoring. */
export function ScorerCard({ scorer, onSaved }: { scorer: Scorer; onSaved: () => void }) {
  const head = scorer.versions[0]
  const [editing, setEditing] = useState(false)
  // Captured when editing starts, so a poll that brings in a colleague's version can't move it (their save → our 409).
  const [base, setBase] = useState(scorer.headVersion)
  const [config, setConfig] = useState(JSON.stringify(head.config, null, 2))
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  async function save() {
    setError(null)
    try {
      await api.createScorerVersion(scorer.id, { baseVersion: base, config: JSON.parse(config), message })
      setEditing(false)
      setMessage('')
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    }
  }
  return (
    <div className="card space-y-2 p-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-slate-900">{scorer.name}</span>
        <span className="chip bg-slate-100 text-slate-600">{KIND_LABEL[scorer.kind]}</span>
        {!editing && scorer.kind !== 'human' && (
          <button type="button" className="btn-ghost ml-auto text-xs" onClick={() => {
              setBase(scorer.headVersion)
              setConfig(JSON.stringify(head.config, null, 2))
              setEditing(true)
            }}>
            New version
          </button>
        )}
      </div>
      <p className="text-xs text-slate-500">{scorer.description}</p>
      <ul className="space-y-1">
        {scorer.versions.map((v) => (
          <li key={v.id} className="rounded bg-slate-50 px-2 py-1.5 text-xs">
            <span className="font-semibold">v{v.version}</span> <span className="text-slate-600">{v.message}</span> <span className="text-slate-400">· {ago(v.createdAt)}</span>
            <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-slate-700">{JSON.stringify(v.config)}</pre>
          </li>
        ))}
      </ul>
      {editing && (
        <div className="space-y-2 border-t border-slate-100 pt-2">
          <textarea className="input h-28 font-mono text-[11px]" value={config} onChange={(e) => setConfig(e.target.value)} aria-label="Config JSON" />
          <input className="input" placeholder="What changed (required)" value={message} onChange={(e) => setMessage(e.target.value)} />
          {error && <ErrorNote message={error} />}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="button" className="btn-primary" disabled={!message.trim()} onClick={() => void save()}>
              Save as v{base + 1}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
