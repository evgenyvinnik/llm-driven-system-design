import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ErrorNote } from '@/components/shared'
import { useOrg } from '@/hooks/useOrg'
import { keys } from '@/lib/keys'
import { api } from '@/services/api'

export function NewPromptForm({ onCreated }: { onCreated: (id: string) => void }) {
  const { orgId, manifest } = useOrg()
  const qc = useQueryClient()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const create = useMutation({
    mutationFn: () => api.createPrompt(orgId, { title, body, projectId: manifest.projects[0]?.id ?? '', sharedRoles: [] }),
    onSuccess: ({ prompt }) => {
      void qc.invalidateQueries({ queryKey: keys.prompts(orgId) })
      onCreated(prompt.id)
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate()
  }
  return (
    <form onSubmit={submit} className="card mb-4 space-y-2 p-4">
      <input className="input" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} required aria-label="Prompt title" />
      <textarea className="input h-24 font-mono text-xs" placeholder="Prompt text" value={body} onChange={(e) => setBody(e.target.value)} required aria-label="Prompt text" />
      <button className="btn-primary" disabled={create.isPending}>Create private prompt</button>
      {create.error && <ErrorNote error={create.error} />}
    </form>
  )
}
