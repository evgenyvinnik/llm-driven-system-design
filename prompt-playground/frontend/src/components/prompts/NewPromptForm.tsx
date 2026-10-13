import { useState, type FormEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ErrorNote } from '@/components/shared'
import { api, ApiError } from '@/services/api'

export function NewPromptForm({ onCancel }: { onCancel: () => void }) {
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const { prompt } = await api.createPrompt({ title, description })
      void navigate({ to: '/prompts/$promptId', params: { promptId: prompt.id } })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the prompt')
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="card mb-4 flex flex-wrap items-end gap-3 p-4">
      <div className="min-w-[16rem] flex-1">
        <label className="label" htmlFor="new-title">
          Title
        </label>
        <input id="new-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus required maxLength={200} />
      </div>
      <div className="min-w-[16rem] flex-[2]">
        <label className="label" htmlFor="new-description">
          Description
        </label>
        <input id="new-description" className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
      </div>
      <button className="btn-primary" disabled={busy || !title.trim()}>
        Create
      </button>
      <button type="button" className="btn-ghost" onClick={onCancel}>
        Cancel
      </button>
      {error && (
        <div className="w-full">
          <ErrorNote message={error} />
        </div>
      )}
    </form>
  )
}
