import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ModuleGate } from '@/components/access'
import { LinkIcon, LockIcon, PlusIcon } from '@/components/icons'
import { NewPromptForm, SharingControls } from '@/components/prompts'
import { ErrorNote, Loading, PageHeader } from '@/components/shared'
import { useCan, useOrg } from '@/hooks/useOrg'
import { ROLE_LABEL, timeAgo } from '@/lib/format'
import { keys } from '@/lib/keys'
import { api } from '@/services/api'

export const Route = createFileRoute('/orgs/$orgId/prompts')({
  validateSearch: (s: Record<string, unknown>): { prompt?: string } => ({ prompt: typeof s.prompt === 'string' ? s.prompt : undefined }),
  component: () => (
    <ModuleGate module="prompts">
      <PromptsPage />
    </ModuleGate>
  ),
})

function PromptDetailPanel({ id }: { id: string }) {
  const { orgId } = useOrg()
  const { data, error, isPending } = useQuery({ queryKey: keys.prompt(orgId, id), queryFn: ({ signal }) => api.prompt(orgId, id, signal) })
  if (isPending) return <Loading />
  if (error || !data) return <ErrorNote error={error} notFound="This prompt doesn't exist or isn't shared with you." />
  const p = data.prompt
  return (
    <div className="card space-y-4 p-4" data-testid="prompt-detail">
      <div>
        <h2 className="text-base font-semibold">{p.title}</h2>
        <p className="text-xs text-slate-500">By {p.ownerName} · {p.projectName} · updated {timeAgo(p.updatedAt)}</p>
      </div>
      <pre className="whitespace-pre-wrap rounded-md bg-slate-50 p-3 font-mono text-xs text-slate-800">{p.body}</pre>
      <SharingControls key={p.id + p.sharedRoles.join()} prompt={p} />
    </div>
  )
}

function PromptsPage() {
  const { orgId } = useOrg()
  const { prompt: selected } = Route.useSearch()
  const navigate = useNavigate()
  const canWrite = useCan('prompts.write')
  const [creating, setCreating] = useState(false)
  const { data, error, isPending } = useQuery({ queryKey: keys.prompts(orgId), queryFn: ({ signal }) => api.prompts(orgId, signal) })
  const select = (id: string) => void navigate({ to: '.', search: { prompt: id } })

  return (
    <div>
      <PageHeader
        title="Prompt library"
        description="Reusable prompts. Private by default; share with roles in this organization or by a revocable link."
        actions={canWrite && <button className="btn-primary" onClick={() => setCreating(true)}><PlusIcon /> New prompt</button>}
      />
      {creating && <NewPromptForm onCreated={(id) => { setCreating(false); select(id) }} />}
      {isPending && <Loading />}
      {error && <ErrorNote error={error} />}
      {data && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <ul className="card divide-y divide-slate-100 self-start">
            {data.prompts.map((p) => (
              <li key={p.id}>
                <button onClick={() => select(p.id)} className={`block w-full px-4 py-3 text-left hover:bg-slate-50 ${selected === p.id ? 'bg-brand-50' : ''}`}>
                  <span className="flex items-center gap-2 text-sm font-medium text-slate-900">
                    {p.title}
                    {p.sharedRoles.length === 0 && <LockIcon className="h-3.5 w-3.5 text-slate-400" title="Private" />}
                    {p.activeLinks > 0 && <LinkIcon className="h-3.5 w-3.5 text-brand-600" title={`${p.activeLinks} active link(s)`} />}
                  </span>
                  <span className="text-xs text-slate-500">
                    {p.ownerName} · {p.sharedRoles.length ? `shared with ${p.sharedRoles.map((r) => ROLE_LABEL[r]).join(', ')}` : 'private'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {selected ? <PromptDetailPanel id={selected} /> : <p className="text-sm text-slate-500">Select a prompt to see it and how it's shared.</p>}
        </div>
      )}
    </div>
  )
}
