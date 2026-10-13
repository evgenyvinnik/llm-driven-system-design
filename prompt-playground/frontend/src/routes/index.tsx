import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { PlusIcon, SearchIcon } from '@/components/icons'
import { RequireAuth } from '@/components/layout'
import { NewPromptForm, PromptTable } from '@/components/prompts'
import { ErrorNote, Loading } from '@/components/shared'
import { api } from '@/services/api'
import type { PromptListItem } from '@/types'

export const Route = createFileRoute('/')({
  component: () => (
    <RequireAuth>
      <PromptLibrary />
    </RequireAuth>
  ),
})

function PromptLibrary() {
  const [prompts, setPrompts] = useState<PromptListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => {
      api
        .listPrompts(query)
        .then(({ prompts }) => {
          setPrompts(prompts)
          setError(null)
        })
        .catch((err: Error) => setError(err.message))
    }, query ? 200 : 0)
    return () => clearTimeout(timer)
  }, [query])

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Prompts</h1>
          <p className="text-sm text-slate-500">Versioned prompts shared with your workspace.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <SearchIcon className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <input className="input w-64 pl-8" placeholder="Search prompts" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <button className="btn-primary" onClick={() => setCreating(true)}>
            <PlusIcon /> New prompt
          </button>
        </div>
      </div>
      {creating && <NewPromptForm onCancel={() => setCreating(false)} />}
      {error && <ErrorNote message={error} />}
      {!prompts && !error ? <Loading /> : prompts && <PromptTable prompts={prompts} />}
    </main>
  )
}
