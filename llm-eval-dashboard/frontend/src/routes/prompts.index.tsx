import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { ago } from '@/lib/format'
import { api } from '@/services/api'
import type { ModelConfig, PromptSummary } from '@/types'

export const Route = createFileRoute('/prompts/')({ component: PromptsPage })

function PromptsPage() {
  const [prompts, setPrompts] = useState<PromptSummary[] | null>(null)
  const [configs, setConfigs] = useState<ModelConfig[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    Promise.all([api.prompts(), api.modelConfigs()])
      .then(([p, c]) => {
        setPrompts(p.prompts)
        setConfigs(c.modelConfigs)
      })
      .catch((err: Error) => setError(err.message))
  }, [])
  return (
    <div className="page">
      <div>
        <h1 className="h1">Prompts and model configs</h1>
        <p className="text-sm text-slate-500">Prompt versions and model configs are immutable, as in the prompt playground: a run pins one of each.</p>
      </div>
      {error && <ErrorNote message={error} />}
      {!prompts ? (
        <Loading />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full" aria-label="Prompts">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="th">Prompt</th>
                <th className="th">Head version</th>
                <th className="th">Runs</th>
                <th className="th">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {prompts.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50">
                  <td className="td">
                    <Link to="/prompts/$promptId" params={{ promptId: p.id }} className="font-medium text-accent-700 hover:underline">
                      {p.name}
                    </Link>
                    <div className="text-xs text-slate-500">{p.description}</div>
                  </td>
                  <td className="td num">v{p.headVersion}</td>
                  <td className="td num">{p.runs}</td>
                  <td className="td text-xs text-slate-500">{ago(p.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="card overflow-x-auto">
        <table className="w-full" aria-label="Model configs">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              <th className="th">Model config</th>
              <th className="th">Model</th>
              <th className="th">Temperature</th>
              <th className="th">Max tokens</th>
              <th className="th">Seed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {configs.map((c) => (
              <tr key={c.id}>
                <td className="td font-medium">{c.name}</td>
                <td className="td font-mono text-xs">{c.model}</td>
                <td className="td num">{c.temperature}</td>
                <td className="td num">{c.maxTokens}</td>
                <td className="td num">{c.seed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
