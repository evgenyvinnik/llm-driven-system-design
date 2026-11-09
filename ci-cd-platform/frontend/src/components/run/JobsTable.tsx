import { Link } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { KeyIcon, ReplayIcon } from '@/components/icons'
import { ErrorNote } from '@/components/shared/Feedback'
import { StatusChip } from '@/components/shared/StatusChip'
import { layoutDag } from '@/lib/dag'
import { duration } from '@/lib/format'
import { api, ApiError } from '@/services/api'
import type { RunDetail, RunJob } from '@/types'
import { RerunConfirm, type UnsafeJob } from './RerunConfirm'

function SecretsCell({ job }: { job: RunJob }) {
  if (job.requestedSecrets.length === 0) return <span className="text-slate-400">—</span>
  return (
    <div className="space-y-0.5">
      {job.secretsReleased.map((name) => (
        <div key={name} className="flex items-center gap-1 font-mono text-[11px] text-emerald-800">
          <KeyIcon className="h-3 w-3" /> {name}
        </div>
      ))}
      {job.secretsWithheld.map((w) => (
        <div key={w.name} className="flex items-center gap-1 font-mono text-[11px] text-orange-800" title={w.reason}>
          <KeyIcon className="h-3 w-3" /> {w.name} withheld
        </div>
      ))}
      {job.secretsReleased.length === 0 && job.secretsWithheld.length === 0 && <span className="text-slate-400">{job.requestedSecrets.length} requested, not released</span>}
    </div>
  )
}

export function JobsTable({ detail, onChanged }: { detail: RunDetail; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<{ jobId: string; jobs: UnsafeJob[] } | null>(null)
  const active = detail.jobs.some((j) => ['queued', 'running', 'waiting'].includes(j.status))
  // In graph order, so the table reads the way the work flows.
  const ordered = useMemo(() => {
    const { nodes } = layoutDag(detail.jobs)
    const position = (key: string) => {
      const node = nodes.get(key)
      return (node?.column ?? 0) * 1000 + (node?.row ?? 0)
    }
    return [...detail.jobs].sort((a, b) => position(a.key) - position(b.key))
  }, [detail.jobs])

  async function rerunJob(jobId: string, confirm = false) {
    setError(null)
    try {
      await api.rerunJob(jobId, confirm)
      setPending(null)
      onChanged()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CONFIRM_REQUIRED') setPending({ jobId, jobs: (err.details as { jobs: UnsafeJob[] }).jobs })
      else setError(err instanceof Error ? err.message : 'Could not re-run')
    }
  }

  return (
    <>
      {error && (
        <div className="p-3">
          <ErrorNote message={error} />
        </div>
      )}
      <table className="w-full" aria-label="Jobs">
        <thead className="border-b border-slate-100">
          <tr>
            <th className="th">Job</th>
            <th className="th">Status</th>
            <th className="th">Attempt</th>
            <th className="th">Runner</th>
            <th className="th">Secrets</th>
            <th className="th">Duration</th>
            {detail.canManage && <th className="th" />}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {ordered.map((job) => (
            <tr key={job.id}>
              <td className="td max-w-md">
                <Link to="/runs/$runId/jobs/$jobId" params={{ runId: detail.run.id, jobId: job.id }} className="link">
                  {job.name}
                </Link>
                {job.hasNonIdempotent && <span className="chip ml-1.5 bg-amber-100 text-amber-800">non-idempotent</span>}
                {job.environment && <span className="chip ml-1.5 bg-violet-100 text-violet-800">{job.environment}</span>}
                {job.statusReason && <div className="mt-0.5 text-xs text-slate-500">{job.statusReason}</div>}
              </td>
              <td className="td">
                <StatusChip status={job.status} />
              </td>
              <td className="td num">{job.attempt}</td>
              <td className="td text-xs">{job.runnerName ?? job.lastRunnerName ?? '—'}</td>
              <td className="td text-xs">
                <SecretsCell job={job} />
              </td>
              <td className="td num whitespace-nowrap text-xs">{duration(job.startedAt, job.finishedAt)}</td>
              {detail.canManage && (
                <td className="td text-right">
                  <button type="button" className="btn-ghost !p-1" disabled={active || job.status === 'needs_attention'} title={job.status === 'needs_attention' ? 'Resolve the unknown outcome first' : `Re-run ${job.name} and its dependents`} aria-label={`Re-run ${job.name}`} onClick={() => void rerunJob(job.id)}>
                    <ReplayIcon className="h-4 w-4" />
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {pending && <RerunConfirm jobs={pending.jobs} onClose={() => setPending(null)} onConfirm={() => void rerunJob(pending.jobId, true)} />}
    </>
  )
}
