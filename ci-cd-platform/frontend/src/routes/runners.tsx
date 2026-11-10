import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { ZapOffIcon } from '@/components/icons'
import { EmptyNote, ErrorNote, Loading } from '@/components/shared/Feedback'
import { millis } from '@/lib/format'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'
import type { Runner } from '@/types'

export const Route = createFileRoute('/runners')({ component: Runners })

function RunnerRow({ runner, leaseMs, onKill }: { runner: Runner; leaseMs: number; onKill: (id: string) => void }) {
  return (
    <tr>
      <td className="td">
        <div className="font-medium text-slate-900">{runner.name}</div>
        <div className="text-xs text-slate-500">
          incarnation {runner.incarnation}
          {runner.pid ? `, pid ${runner.pid}` : ''}
        </div>
      </td>
      <td className="td">
        <span className={`chip ${runner.online ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'}`}>{runner.online ? 'online' : 'offline'}</span>
      </td>
      <td className="td">
        <div className="flex flex-wrap gap-1">
          {runner.labels.map((l) => (
            <span key={l} className="chip bg-slate-100 text-slate-700">
              {l}
            </span>
          ))}
        </div>
      </td>
      <td className="td num text-xs">
        {runner.jobs.length} / {runner.slots}
      </td>
      <td className="td num whitespace-nowrap text-xs">{millis(runner.lastSeenMs)} ago</td>
      <td className="td text-xs">
        {runner.jobs.length === 0 && <span className="text-slate-400">idle</span>}
        <ul className="space-y-1.5">
          {runner.jobs.map((job, i) => (
            <li key={job.visible ? job.jobId : i}>
              {job.visible ? (
                <Link to="/runs/$runId/jobs/$jobId" params={{ runId: job.runId, jobId: job.jobId }} className="link">
                  {job.repository} #{job.runNumber}: {job.jobName}
                </Link>
              ) : (
                <span className="text-slate-500">busy with a job you cannot see</span>
              )}
              <div className="num text-slate-500">
                {job.visible ? `attempt ${job.attempt}, token ${job.fencingToken}, ` : ''}lease {millis(job.leaseExpiresInMs)} of {millis(leaseMs)}, heartbeat {millis(job.lastHeartbeatMs)} ago
              </div>
            </li>
          ))}
        </ul>
      </td>
      <td className="td text-right">
        <button type="button" className="btn-danger" disabled={!runner.online} title="The next heartbeat tells this runner to SIGKILL itself" onClick={() => onKill(runner.id)}>
          <ZapOffIcon className="h-4 w-4" /> Kill
        </button>
      </td>
    </tr>
  )
}

function Runners() {
  const { data, error, loading, reload } = usePoll(api.runners, 1000)
  const [killError, setKillError] = useState<string | null>(null)
  if (loading && !data) return <Loading />

  async function kill(id: string) {
    setKillError(null)
    try {
      await api.killRunner(id)
      reload()
    } catch (err) {
      setKillError(err instanceof Error ? err.message : 'Could not kill the runner')
    }
  }

  return (
    <div className="page">
      <div>
        <h1 className="h1">Runners</h1>
        <p className="mt-1 text-sm text-slate-600">Each running job holds a lease the runner renews with its heartbeat, and a fencing token that every write is checked against. A killed runner stops renewing, and the lease sweep decides what happens to its job. The local supervisor brings it back as a new incarnation.</p>
      </div>
      {error && <ErrorNote message={error} />}
      {killError && <ErrorNote message={killError} />}
      {data && data.runners.length === 0 && <EmptyNote>No runner has registered yet.</EmptyNote>}
      {data && data.runners.length > 0 && (
        <table className="card w-full overflow-hidden" aria-label="Runners">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              <th className="th">Runner</th>
              <th className="th">State</th>
              <th className="th">Labels</th>
              <th className="th">Slots</th>
              <th className="th">Last seen</th>
              <th className="th">Jobs and leases</th>
              <th className="th" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.runners.map((r) => (
              <RunnerRow key={r.id} runner={r} leaseMs={data.leaseMs} onKill={(id) => void kill(id)} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
