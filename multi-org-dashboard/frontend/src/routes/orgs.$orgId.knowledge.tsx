import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ModuleGate } from '@/components/access'
import { PlusIcon } from '@/components/icons'
import { ErrorNote, Loading, PageHeader, StatusBadge } from '@/components/shared'
import { useCan, useOrg } from '@/hooks/useOrg'
import { timeAgo } from '@/lib/format'
import { keys } from '@/lib/keys'
import { api } from '@/services/api'

export const Route = createFileRoute('/orgs/$orgId/knowledge')({
  component: () => (
    <ModuleGate module="knowledge">
      <KnowledgePage />
    </ModuleGate>
  ),
})

function AddDocForm({ onDone }: { onDone: () => void }) {
  const { orgId, manifest } = useOrg()
  const qc = useQueryClient()
  const [title, setTitle] = useState('')
  const [source, setSource] = useState('url')
  const [projectId, setProjectId] = useState(manifest.projects[0]?.id ?? '')
  const add = useMutation({
    mutationFn: () => api.createDoc(orgId, { title, source, projectId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.knowledge(orgId) })
      onDone()
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    add.mutate()
  }
  return (
    <form onSubmit={submit} className="card mb-4 grid grid-cols-1 gap-3 p-4 md:grid-cols-4">
      <input className="input md:col-span-2" placeholder="Document title" value={title} onChange={(e) => setTitle(e.target.value)} required aria-label="Document title" />
      <select className="input" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source">
        <option value="url">Web page</option><option value="upload">Upload</option><option value="helpdesk">Help desk</option>
      </select>
      <div className="flex gap-2">
        <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
          {manifest.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button className="btn-primary" disabled={add.isPending}>Add</button>
      </div>
      {add.error && <div className="md:col-span-4"><ErrorNote error={add.error} /></div>}
    </form>
  )
}

function KnowledgePage() {
  const { orgId } = useOrg()
  const canWrite = useCan('knowledge.write')
  const [adding, setAdding] = useState(false)
  const { data, error, isPending } = useQuery({ queryKey: keys.knowledge(orgId), queryFn: ({ signal }) => api.knowledge(orgId, signal) })
  return (
    <div>
      <PageHeader
        title="Knowledge base"
        description="Documents your agents answer from."
        actions={canWrite && <button className="btn-primary" onClick={() => setAdding(true)}><PlusIcon /> Add document</button>}
      />
      {adding && canWrite && <AddDocForm onDone={() => setAdding(false)} />}
      {isPending && <Loading />}
      {error && <ErrorNote error={error} />}
      {data && (
        <table className="card w-full overflow-hidden">
          <thead className="bg-slate-50">
            <tr><th className="th">Title</th><th className="th">Project</th><th className="th">Source</th><th className="th">Chunks</th><th className="th">Status</th><th className="th">Added</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.docs.map((d) => (
              <tr key={d.id}>
                <td className="td font-medium text-slate-900">{d.title}</td>
                <td className="td">{d.projectName}</td>
                <td className="td">{d.source}</td>
                <td className="td">{d.chunks}</td>
                <td className="td"><StatusBadge status={d.status} /></td>
                <td className="td text-slate-500">{timeAgo(d.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
