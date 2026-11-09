import { useState } from 'react'
import { ReplayIcon, StopIcon } from '@/components/icons'
import { ErrorNote } from '@/components/shared/Feedback'
import { api, ApiError } from '@/services/api'
import type { RunDetail } from '@/types'
import { RerunConfirm, type UnsafeJob } from './RerunConfirm'

const ACTIVE = ['blocked', 'queued', 'waiting', 'running']

export function RunActions({ detail, onChanged }: { detail: RunDetail; onChanged: () => void }) {
  const { run, jobs } = detail
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<{ mode: 'failed' | 'all'; jobs: UnsafeJob[] } | null>(null)
  const active = jobs.some((j) => ['queued', 'running', 'waiting'].includes(j.status))
  const hasFailed = jobs.some((j) => ['failure', 'cancelled', 'skipped'].includes(j.status))
  const cancellable = jobs.some((j) => ACTIVE.includes(j.status)) && run.status !== 'invalid'

  async function rerun(mode: 'failed' | 'all', confirm = false) {
    setError(null)
    try {
      await api.rerunRun(run.id, mode, confirm)
      setPending(null)
      onChanged()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CONFIRM_REQUIRED') setPending({ mode, jobs: (err.details as { jobs: UnsafeJob[] }).jobs })
      else setError(err instanceof Error ? err.message : 'Could not re-run')
    }
  }

  async function cancel() {
    setError(null)
    try {
      await api.cancelRun(run.id)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel')
    }
  }

  if (!detail.canManage) return <span className="text-xs text-slate-500">Read-only access: re-run and cancel are for maintainers.</span>
  if (run.status === 'invalid') return null
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="btn-secondary" disabled={active || !hasFailed} onClick={() => void rerun('failed')}>
          <ReplayIcon className="h-4 w-4" /> Re-run failed
        </button>
        <button type="button" className="btn-secondary" disabled={active} onClick={() => void rerun('all')}>
          <ReplayIcon className="h-4 w-4" /> Re-run all
        </button>
        <button type="button" className="btn-danger" disabled={!cancellable || run.cancelRequestedAt !== null} onClick={() => void cancel()}>
          <StopIcon className="h-4 w-4" /> {run.cancelRequestedAt && cancellable ? 'Cancelling…' : 'Cancel'}
        </button>
      </div>
      {error && <ErrorNote message={error} />}
      {pending && <RerunConfirm jobs={pending.jobs} onClose={() => setPending(null)} onConfirm={() => void rerun(pending.mode, true)} />}
    </div>
  )
}
