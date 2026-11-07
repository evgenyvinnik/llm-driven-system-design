import { useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { PlayIcon } from '@/components/icons'
import { ErrorNote } from '@/components/shared/Loading'
import { newIdempotencyKey } from '@/lib/format'
import { api } from '@/services/api'
import type { DatasetDetail, ModelConfig, PromptDetail, Scorer } from '@/types'

interface Catalog {
  datasets: DatasetDetail[]
  prompts: PromptDetail[]
  configs: ModelConfig[]
  scorers: Scorer[]
}

/**
 * The Idempotency-Key is created once per form, so a double click or a retry
 * after a lost response returns the same run instead of starting a second one.
 */
export function NewRunForm({ catalog }: { catalog: Catalog }) {
  const navigate = useNavigate()
  const [key] = useState(newIdempotencyKey)
  const [datasetVersionId, setDatasetVersionId] = useState(catalog.datasets[0]?.versions[0]?.id ?? '')
  const [promptVersionId, setPromptVersionId] = useState(catalog.prompts[0]?.versions[0]?.id ?? '')
  const [modelConfigId, setModelConfigId] = useState(catalog.configs[0]?.id ?? '')
  const [scorerIds, setScorerIds] = useState<string[]>([])
  const [samples, setSamples] = useState(5)
  const [concurrency, setConcurrency] = useState(4)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const automated = useMemo(() => catalog.scorers.filter((s) => s.kind !== 'human'), [catalog.scorers])
  useEffect(() => {
    if (scorerIds.length === 0 && automated[0]) setScorerIds([automated[0].versions[0].id])
  }, [automated, scorerIds.length])

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const { run } = await api.createRun({ name: name || undefined, datasetVersionId, promptVersionId, modelConfigId, scorerVersionIds: scorerIds, samplesPerCase: samples, concurrencyLimit: concurrency }, key)
      void navigate({ to: '/runs/$runId', params: { runId: run.id } })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the run')
    } finally {
      setBusy(false)
    }
  }

  const toggle = (id: string) => setScorerIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))
  return (
    <div className="card space-y-4 p-5">
      <div className="grid grid-cols-2 gap-4">
        <label className="block">
          <span className="label">Dataset version</span>
          <select className="input" value={datasetVersionId} onChange={(e) => setDatasetVersionId(e.target.value)}>
            {catalog.datasets.flatMap((d) => d.versions.map((v) => <option key={v.id} value={v.id}>{`${d.name} v${v.version} (${v.caseCount} cases)`}</option>))}
          </select>
        </label>
        <label className="block">
          <span className="label">Prompt version</span>
          <select className="input" value={promptVersionId} onChange={(e) => setPromptVersionId(e.target.value)}>
            {catalog.prompts.flatMap((p) => p.versions.map((v) => <option key={v.id} value={v.id}>{`${p.name} v${v.version}: ${v.message}`}</option>))}
          </select>
        </label>
        <label className="block">
          <span className="label">Model config</span>
          <select className="input" value={modelConfigId} onChange={(e) => setModelConfigId(e.target.value)}>
            {catalog.configs.map((c) => <option key={c.id} value={c.id}>{`${c.name} (${c.model}, t=${c.temperature}, seed ${c.seed})`}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="label">Name (optional)</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Derived from the pins" />
        </label>
        <label className="block">
          <span className="label">Samples per case</span>
          <input className="input" type="number" min={1} max={20} value={samples} onChange={(e) => setSamples(Number(e.target.value))} />
          <span className="text-[11px] text-slate-500">≥ 2 at temperature &gt; 0, or per-case noise is invisible</span>
        </label>
        <label className="block">
          <span className="label">Concurrency limit</span>
          <input className="input" type="number" min={1} max={64} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} />
          <span className="text-[11px] text-slate-500">Model calls in flight for this run, across all workers</span>
        </label>
      </div>
      <fieldset>
        <legend className="label">Scorer versions</legend>
        <div className="grid grid-cols-3 gap-2">
          {automated.flatMap((s) =>
            s.versions.map((v) => (
              <label key={v.id} className="flex items-center gap-2 rounded border border-slate-200 px-2 py-1.5 text-sm">
                <input type="checkbox" checked={scorerIds.includes(v.id)} onChange={() => toggle(v.id)} />
                {s.name} v{v.version}
              </label>
            )),
          )}
        </div>
      </fieldset>
      {error && <ErrorNote message={error} />}
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] text-slate-400">Idempotency-Key: {key}</span>
        <button type="button" className="btn-primary" disabled={busy || scorerIds.length === 0} onClick={() => void submit()}>
          <PlayIcon /> {busy ? 'Starting…' : 'Start run'}
        </button>
      </div>
    </div>
  )
}
