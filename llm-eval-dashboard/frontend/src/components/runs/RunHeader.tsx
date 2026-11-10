import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { CompareIcon, FlagIcon, RetryIcon, ScaleIcon, StopIcon } from '@/components/icons'
import { RunStatusChip } from '@/components/shared/Chips'
import { ErrorNote } from '@/components/shared/Loading'
import { ago, duration } from '@/lib/format'
import { api } from '@/services/api'
import type { RunDetail } from '@/types'

export function RunHeader({ detail, onChanged, onRescore }: { detail: RunDetail; onChanged: () => void; onRescore: () => void }) {
  const { run, progress } = detail
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const active = run.status === 'queued' || run.status === 'running'
  const finished = run.status === 'completed' || run.status === 'failed'

  async function act(name: string, fn: () => Promise<string>) {
    setBusy(name)
    setError(null)
    try {
      setNote(await fn())
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="h1">{run.name}</h1>
            <RunStatusChip status={run.status} errored={progress.errored} />
            {run.retryRound > 0 && <span className="chip bg-slate-100 text-slate-600">retry round {run.retryRound}</span>}
          </div>
          <p className="mt-1 text-sm text-slate-600">
            <Link to="/datasets/$datasetId" params={{ datasetId: run.dataset.id }} className="hover:underline">
              {run.dataset.name} <b>v{run.dataset.version}</b>
            </Link>{' '}
            ·{' '}
            <Link to="/prompts/$promptId" params={{ promptId: run.prompt.id }} className="hover:underline">
              {run.prompt.name} <b>v{run.prompt.version}</b>
            </Link>{' '}
            · {run.modelConfig.name} ({run.modelConfig.model}, t={run.modelConfig.temperature}, max {run.modelConfig.maxTokens}, seed {run.modelConfig.seed}) · ×{run.samplesPerCase} samples · limit {run.concurrencyLimit}
          </p>
          <p className="text-xs text-slate-400">
            <span className="font-mono">{run.id}</span> · by {run.createdBy} {ago(run.createdAt)} · took {duration(run.startedAt, run.finishedAt)}
            {run.failureReason && <span className="text-rose-700"> · {run.failureReason}</span>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {active && (
            <button type="button" className="btn-danger" disabled={busy !== null} onClick={() => void act('cancel', async () => `Cancelled; ${(await api.cancelRun(run.id)).cancelledTasks} queued tasks will not run.`)}>
              <StopIcon /> Cancel
            </button>
          )}
          {finished && progress.errored > 0 && (
            <button
              type="button"
              className="btn-secondary"
              disabled={busy !== null}
              onClick={() => void act('retry', async () => `Re-queued ${(await api.retryErrored(run.id)).requeued} errored tasks; successful ones are untouched.`)}
            >
              <RetryIcon /> Retry {progress.errored} errored
            </button>
          )}
          {!active && (
            <button type="button" className="btn-secondary" onClick={onRescore}>
              <ScaleIcon /> Re-score
            </button>
          )}
          <Link to="/annotate/$runId" params={{ runId: run.id }} className="btn-secondary">
            <FlagIcon /> Annotate
          </Link>
          <Link to="/compare" search={{ a: run.id }} className="btn-secondary">
            <CompareIcon /> Compare
          </Link>
        </div>
      </div>
      {note && <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{note}</div>}
      {error && <ErrorNote message={error} />}
    </div>
  )
}
