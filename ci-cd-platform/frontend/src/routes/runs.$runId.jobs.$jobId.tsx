import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { ReplayIcon } from '@/components/icons'
import { AttemptFacts } from '@/components/job/AttemptFacts'
import { LeaseBadge } from '@/components/job/LeaseBadge'
import { LogViewer } from '@/components/job/LogViewer'
import { Timeline } from '@/components/job/Timeline'
import { ApprovalPanel } from '@/components/run/ApprovalPanel'
import { AttentionPanel } from '@/components/run/AttentionPanel'
import { RerunConfirm, type UnsafeJob } from '@/components/run/RerunConfirm'
import { ErrorNote, Loading, Panel } from '@/components/shared/Feedback'
import { StatusChip } from '@/components/shared/StatusChip'
import { usePoll } from '@/lib/use-poll'
import { api, ApiError } from '@/services/api'

export const Route = createFileRoute('/runs/$runId/jobs/$jobId')({ component: JobPage })

function JobPage() {
  const { runId, jobId } = Route.useParams()
  const { data, error, errorStatus, reload } = usePoll(() => api.job(jobId), 1500, [jobId])
  const [selected, setSelected] = useState<number | null>(null)
  const [rerunError, setRerunError] = useState<string | null>(null)
  const [pending, setPending] = useState<UnsafeJob[] | null>(null)
  const latest = data?.job.attempt ?? null

  // Follow new attempts unless the viewer picked an older one on purpose.
  useEffect(() => setSelected(null), [latest])

  async function rerun(confirm = false) {
    setRerunError(null)
    try {
      await api.rerunJob(jobId, confirm)
      setPending(null)
      reload()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CONFIRM_REQUIRED') setPending((err.details as { jobs: UnsafeJob[] }).jobs)
      else setRerunError(err instanceof Error ? err.message : 'Could not re-run')
    }
  }

  if (errorStatus === 404) return <main className="page"><ErrorNote message="This job does not exist, or you do not have access to it." /></main>
  if (!data) return error ? <div className="page"><ErrorNote message={error} /></div> : <Loading />
  const { job, run, attempts, canManage } = data
  const attemptNumber = selected ?? job.attempt
  const attempt = attempts.find((a) => a.attempt === attemptNumber) ?? attempts[0]
  const active = attempt.attempt === job.attempt && ['queued', 'running'].includes(job.status)

  return (
    <div className="page">
      <header className="space-y-2">
        <div className="text-sm text-slate-500">
          <Link to="/runs/$runId" params={{ runId }} className="link">
            run #{run.number}: {run.commitMessage}
          </Link>{' '}
          / {job.key}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="h1">{job.name}</h1>
          <StatusChip status={job.status} />
          <span className="chip bg-slate-100 text-slate-600">runs on {job.runsOn.join(', ')}</span>
          {job.environment && <span className="chip bg-violet-100 text-violet-800">{job.environment}</span>}
          <LeaseBadge job={job} />
          <div className="flex-1" />
          {canManage && (
            <button type="button" className="btn-secondary" disabled={['queued', 'running', 'waiting', 'needs_attention'].includes(job.status) || ['running'].includes(run.status)} onClick={() => void rerun()}>
              <ReplayIcon className="h-4 w-4" /> Re-run this job
            </button>
          )}
        </div>
        {job.needs.length > 0 && <p className="text-xs text-slate-500">Needs: {job.needs.join(', ')}</p>}
        {rerunError && <ErrorNote message={rerunError} />}
        {error && <ErrorNote message={`Showing the last known state: ${error}`} />}
      </header>
      {job.status === 'needs_attention' && <AttentionPanel runId={runId} jobId={job.id} jobName={job.name} reason={job.statusReason} canManage={canManage} lateReport={attempts[0]?.lateReport} onChanged={reload} />}
      {job.status === 'waiting' && <ApprovalPanel jobId={job.id} jobName={job.name} environment={job.environment} reason={job.statusReason} canManage={canManage} onChanged={reload} />}
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Attempts">
        <span className="panel-title">Attempts</span>
        {attempts.map((a) => (
          <button key={a.attempt} type="button" role="tab" aria-selected={a.attempt === attempt.attempt} className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${a.attempt === attempt.attempt ? 'border-accent-500 bg-white' : 'border-transparent hover:bg-slate-100'}`} onClick={() => setSelected(a.attempt)}>
            <span className="font-medium">#{a.attempt}</span> <StatusChip status={a.status} />
          </button>
        ))}
      </div>
      <Panel title={`Attempt ${attempt.attempt}`} label="Attempt details">
        <AttemptFacts attempt={attempt} />
      </Panel>
      <LogViewer key={attempt.attempt} jobId={job.id} attempt={attempt.attempt} active={active} />
      <Panel title="Timeline" label="Timeline panel">
        <Timeline transitions={attempt.transitions} />
      </Panel>
      {pending && <RerunConfirm jobs={pending} onClose={() => setPending(null)} onConfirm={() => void rerun(true)} />}
    </div>
  )
}
