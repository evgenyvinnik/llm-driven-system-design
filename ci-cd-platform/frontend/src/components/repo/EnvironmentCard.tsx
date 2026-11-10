import { useState } from 'react'
import { ShieldIcon } from '@/components/icons'
import { ErrorNote } from '@/components/shared/Feedback'
import { api } from '@/services/api'
import type { Environment } from '@/types'

export function EnvironmentCard({ repoId, environment, canManage, onSaved }: { repoId: string; environment: Environment; canManage: boolean; onSaved: () => void }) {
  const [approval, setApproval] = useState(environment.requiredApproval)
  const [branches, setBranches] = useState(environment.allowedBranches.join(', '))
  const [error, setError] = useState<string | null>(null)
  const isProtected = environment.requiredApproval || environment.allowedBranches.length > 0
  const dirty = approval !== environment.requiredApproval || branches !== environment.allowedBranches.join(', ')

  async function save() {
    setError(null)
    try {
      await api.saveEnvironment(repoId, environment.name, {
        requiredApproval: approval,
        allowedBranches: branches
          .split(',')
          .map((b) => b.trim())
          .filter(Boolean),
      })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    }
  }

  return (
    <div className="card space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <ShieldIcon className={`h-4 w-4 ${isProtected ? 'text-violet-600' : 'text-slate-400'}`} /> {environment.name}
        </h2>
        <span className={`chip ${isProtected ? 'bg-violet-100 text-violet-800' : 'bg-slate-100 text-slate-600'}`}>{isProtected ? 'protected' : 'open'}</span>
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={approval} disabled={!canManage} onChange={(e) => setApproval(e.target.checked)} />
        Require a maintainer's approval for every attempt
      </label>
      <div>
        <label className="label" htmlFor={`branches-${environment.id}`}>
          Allowed branches (comma separated; empty allows all)
        </label>
        <input id={`branches-${environment.id}`} className="input font-mono" value={branches} disabled={!canManage} onChange={(e) => setBranches(e.target.value)} placeholder="main, release/*" />
      </div>
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>
          {environment.secretCount} secret{environment.secretCount === 1 ? '' : 's'} scoped here
        </span>
        {canManage && (
          <button type="button" className="btn-secondary" disabled={!dirty} onClick={() => void save()}>
            Save rules
          </button>
        )}
      </div>
      {error && <ErrorNote message={error} />}
    </div>
  )
}
