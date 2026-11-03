import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ModuleGate } from '@/components/access'
import { AgentEditor, NewAgentForm } from '@/components/agents'
import { PlusIcon, TrashIcon } from '@/components/icons'
import { ErrorNote, Loading, PageHeader, StatusBadge } from '@/components/shared'
import { useCan, useOrg } from '@/hooks/useOrg'
import { timeAgo } from '@/lib/format'
import { keys } from '@/lib/keys'
import { api } from '@/services/api'
import { useToasts } from '@/stores/toast-store'
import type { Agent } from '@/types'

export const Route = createFileRoute('/orgs/$orgId/agents')({
  component: () => (
    <ModuleGate module="agents">
      <AgentsPage />
    </ModuleGate>
  ),
})

function AgentsPage() {
  const { orgId } = useOrg()
  const qc = useQueryClient()
  const canWrite = useCan('agents.write')
  const canDelete = useCan('agents.delete')
  const toast = useToasts((s) => s.push)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const { data, error, isPending } = useQuery({ queryKey: keys.agents(orgId), queryFn: ({ signal }) => api.agents(orgId, signal) })
  const invalidate = () => void qc.invalidateQueries({ queryKey: keys.agents(orgId) })
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: Agent['status'] }) => api.updateAgent(orgId, id, { status }),
    onSuccess: invalidate,
    onError: (err) => toast({ tone: 'error', title: 'Could not update the agent', body: (err as Error).message }),
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteAgent(orgId, id),
    onSuccess: invalidate,
    onError: (err) => toast({ tone: 'error', title: 'Could not delete the agent', body: (err as Error).message }),
  })
  const selected = data?.agents.find((a) => a.id === editing)

  return (
    <div>
      <PageHeader
        title="Agents"
        description="Support agents in the projects you can access."
        actions={canWrite && <button className="btn-primary" onClick={() => setCreating(true)}><PlusIcon /> New agent</button>}
      />
      {creating && canWrite && <NewAgentForm onDone={() => setCreating(false)} />}
      {isPending && <Loading />}
      {error && <ErrorNote error={error} />}
      {data && (
        <div className="flex gap-4">
          <table className="card w-full table-auto overflow-hidden">
            <thead className="bg-slate-50">
              <tr><th className="th">Name</th><th className="th">Project</th><th className="th">Model</th><th className="th">Status</th><th className="th">7d conversations</th><th className="th">Updated</th><th className="th" /></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.agents.map((a) => (
                <tr key={a.id} className={editing === a.id ? 'bg-brand-50/50' : ''}>
                  <td className="td"><button className="font-medium text-slate-900 hover:underline" onClick={() => setEditing(a.id)}>{a.name}</button></td>
                  <td className="td">{a.projectName}</td>
                  <td className="td font-mono text-xs">{a.model}</td>
                  <td className="td">
                    {canWrite ? (
                      <select
                        aria-label={`Status of ${a.name}`}
                        className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-xs"
                        value={a.status}
                        onChange={(e) => setStatus.mutate({ id: a.id, status: e.target.value as Agent['status'] })}
                      >
                        <option>draft</option><option>live</option><option>paused</option>
                      </select>
                    ) : (
                      <StatusBadge status={a.status} />
                    )}
                  </td>
                  <td className="td">{a.conversations7d}</td>
                  <td className="td text-slate-500">{timeAgo(a.updatedAt)}</td>
                  <td className="td text-right">
                    {canDelete && (
                      <button className="btn-ghost px-1.5 text-red-600" aria-label={`Delete ${a.name}`} onClick={() => window.confirm(`Delete ${a.name}?`) && remove.mutate(a.id)}>
                        <TrashIcon />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {selected && <AgentEditor key={selected.id} agent={selected} onClose={() => setEditing(null)} />}
        </div>
      )}
    </div>
  )
}
