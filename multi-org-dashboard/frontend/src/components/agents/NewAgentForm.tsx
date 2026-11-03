import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useOrg } from '@/hooks/useOrg'
import { keys } from '@/lib/keys'
import { getActiveOrgId } from '@/lib/org-scope'
import { api } from '@/services/api'
import { ErrorNote } from '@/components/shared'
import { MODELS } from './models'

export function NewAgentForm({ onDone }: { onDone: () => void }) {
  const { orgId, manifest } = useOrg()
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [model, setModel] = useState(MODELS[1])
  const [projectId, setProjectId] = useState(manifest.projects[0]?.id ?? '')
  const create = useMutation({
    mutationFn: () => api.createAgent(orgId, { name, model, projectId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.agents(orgId) })
      // A response for an org the user has left must not close dialogs in the new one.
      if (getActiveOrgId() === orgId) onDone()
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate()
  }
  return (
    <form onSubmit={submit} className="card mb-4 grid grid-cols-1 gap-3 p-4 md:grid-cols-4">
      <div>
        <label className="label" htmlFor="agent-name">Name</label>
        <input id="agent-name" className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
      </div>
      <div>
        <label className="label" htmlFor="agent-model">Model</label>
        <select id="agent-model" className="input" value={model} onChange={(e) => setModel(e.target.value)}>
          {MODELS.map((m) => <option key={m}>{m}</option>)}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="agent-project">Project</label>
        <select id="agent-project" className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          {manifest.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div className="flex items-end gap-2">
        <button className="btn-primary" disabled={create.isPending || !name}>Create agent</button>
        <button type="button" className="btn-ghost" onClick={onDone}>Cancel</button>
      </div>
      {create.error && <div className="md:col-span-4"><ErrorNote error={create.error} /></div>}
    </form>
  )
}
