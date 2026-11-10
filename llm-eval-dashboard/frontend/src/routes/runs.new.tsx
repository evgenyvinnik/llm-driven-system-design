import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { NewRunForm } from '@/components/runs/NewRunForm'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { api } from '@/services/api'
import type { DatasetDetail, ModelConfig, PromptDetail, Scorer } from '@/types'

export const Route = createFileRoute('/runs/new')({ component: NewRunPage })

function NewRunPage() {
  const [catalog, setCatalog] = useState<{ datasets: DatasetDetail[]; prompts: PromptDetail[]; configs: ModelConfig[]; scorers: Scorer[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void (async () => {
      try {
        const [ds, ps, cs, ss] = await Promise.all([api.datasets(), api.prompts(), api.modelConfigs(), api.scorers()])
        const datasets = await Promise.all(ds.datasets.map((d) => api.dataset(d.id).then((r) => r.dataset)))
        const prompts = await Promise.all(ps.prompts.map((p) => api.prompt(p.id).then((r) => r.prompt)))
        setCatalog({ datasets, prompts, configs: cs.modelConfigs, scorers: ss.scorers })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load the catalog')
      }
    })()
  }, [])
  return (
    <div className="page max-w-4xl">
      <div>
        <h1 className="h1">New eval run</h1>
        <p className="text-sm text-slate-500">Everything is pinned by version, so the run means the same thing forever.</p>
      </div>
      {error && <ErrorNote message={error} />}
      {catalog ? <NewRunForm catalog={catalog} /> : !error && <Loading />}
    </div>
  )
}
