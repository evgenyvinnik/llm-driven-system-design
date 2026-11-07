import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { PromptEditor } from '@/components/prompts/PromptEditor'
import { Tag } from '@/components/shared/Chips'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { ago } from '@/lib/format'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'

export const Route = createFileRoute('/prompts/$promptId')({ component: PromptPage })

function PromptPage() {
  const { promptId } = Route.useParams()
  const { data, error, reload } = usePoll(() => api.prompt(promptId), 15_000, [promptId])
  const [editing, setEditing] = useState(false)
  const p = data?.prompt
  if (error && !p) return <div className="page"><ErrorNote message={error} /></div>
  if (!p) return <div className="page"><Loading /></div>
  return (
    <div className="page max-w-5xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="h1">{p.name}</h1>
          <p className="text-sm text-slate-500">{p.description}</p>
        </div>
        {!editing && (
          <button type="button" className="btn-primary" onClick={() => setEditing(true)}>
            New version
          </button>
        )}
      </div>
      {editing && (
        <PromptEditor
          promptId={p.id}
          head={p.versions[0]}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false)
            reload()
          }}
        />
      )}
      <div className="space-y-3" aria-label="Prompt versions">
        {p.versions.map((v) => (
          <div key={v.id} className="card p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">v{v.version}</span>
              {v.version === p.headVersion && <span className="chip bg-accent-100 text-accent-700">head</span>}
              <span className="text-sm text-slate-600">{v.message}</span>
              <span className="ml-auto text-xs text-slate-400">
                {v.createdBy} {ago(v.createdAt)} · {v.runs} runs
              </span>
            </div>
            <div className="mt-1 flex gap-1">{v.variables.map((x) => <Tag key={x}>{`{{${x}}}`}</Tag>)}</div>
            {v.system && <pre className="mt-2 whitespace-pre-wrap rounded bg-slate-100 p-2 font-mono text-[11px] text-slate-600">{v.system}</pre>}
            <pre className="mt-2 whitespace-pre-wrap rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-800">{v.template}</pre>
          </div>
        ))}
      </div>
    </div>
  )
}
