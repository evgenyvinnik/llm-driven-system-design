import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { XIcon } from '@/components/icons'
import { ErrorNote } from '@/components/shared'
import { useCan, useOrg } from '@/hooks/useOrg'
import { keys } from '@/lib/keys'
import { api } from '@/services/api'
import type { Agent } from '@/types'
import { MODELS } from './models'

/**
 * Edit panel. If the user loses agents.write while it is open, the form turns
 * read-only and says so, but keeps their text on screen so it can be copied:
 * losing a permission should never silently throw away someone's work.
 */
export function AgentEditor({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { orgId } = useOrg()
  const canWrite = useCan('agents.write')
  const qc = useQueryClient()
  const [instructions, setInstructions] = useState(agent.instructions)
  const [model, setModel] = useState(agent.model)
  const [wasEditable] = useState(canWrite)
  const dirty = instructions !== agent.instructions || model !== agent.model
  const save = useMutation({
    mutationFn: () => api.updateAgent(orgId, agent.id, { instructions, model }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.agents(orgId) }),
  })

  return (
    <aside className="card w-96 shrink-0 self-start p-4" aria-label={`Edit ${agent.name}`}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">{agent.name}</h2>
        <button className="text-slate-400 hover:text-slate-600" onClick={onClose} aria-label="Close"><XIcon /></button>
      </div>
      {wasEditable && !canWrite && (
        <p className="mb-3 rounded-md bg-amber-50 p-2 text-xs text-amber-900" role="alert" data-testid="lost-write">
          You can no longer edit agents in this organization, so this form is read-only.
          {dirty && ' Your unsaved text is still below if you want to copy it.'}
        </p>
      )}
      <label className="label" htmlFor="editor-model">Model</label>
      <select id="editor-model" className="input mb-3" value={model} onChange={(e) => setModel(e.target.value)} disabled={!canWrite}>
        {MODELS.map((m) => <option key={m}>{m}</option>)}
      </select>
      <label className="label" htmlFor="editor-instructions">Instructions</label>
      <textarea
        id="editor-instructions"
        className="input h-48 font-mono text-xs"
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        readOnly={!canWrite}
      />
      {save.error && <div className="mt-2"><ErrorNote error={save.error} /></div>}
      {canWrite && (
        <button className="btn-primary mt-3" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isSuccess && !dirty ? 'Saved' : 'Save changes'}
        </button>
      )}
    </aside>
  )
}
