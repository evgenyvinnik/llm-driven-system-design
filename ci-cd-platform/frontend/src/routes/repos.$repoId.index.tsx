import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { GitForkIcon } from '@/components/icons'
import { RepoNav } from '@/components/repo/RepoNav'
import { EmptyNote, ErrorNote, Loading } from '@/components/shared/Feedback'
import { StatusChip } from '@/components/shared/StatusChip'
import { duration, shortSha, timeAgo } from '@/lib/format'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'
import type { RunListItem } from '@/types'

export const Route = createFileRoute('/repos/$repoId/')({ component: RepoRuns })

const FILTERS = ['all', 'running', 'waiting', 'needs_attention', 'success', 'failure', 'cancelled', 'invalid']

function JobCounts({ counts }: { counts: RunListItem['jobCounts'] }) {
  const total = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0)
  if (total === 0) return <span className="text-slate-400">no jobs</span>
  return (
    <span className="whitespace-nowrap">
      {counts.success ?? 0}/{total} passed
      {(counts.failure ?? 0) > 0 && <span className="ml-1 text-rose-700">{counts.failure} failed</span>}
      {(counts.skipped ?? 0) > 0 && <span className="ml-1 text-slate-500">{counts.skipped} skipped</span>}
    </span>
  )
}

function RepoRuns() {
  const { repoId } = Route.useParams()
  const [filter, setFilter] = useState('all')
  const repo = usePoll(() => api.repo(repoId), 0, [repoId])
  const runs = usePoll(() => api.runs(repoId, filter === 'all' ? undefined : filter), 2000, [repoId, filter])
  if (repo.errorStatus === 404) return <main className="page"><ErrorNote message="This repository does not exist, or you do not have access to it." /></main>
  if (!repo.data) return <Loading />
  return (
    <div className="page">
      <RepoNav repo={repo.data} />
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter runs by status">
        {FILTERS.map((f) => (
          <button key={f} type="button" className={`chip ${filter === f ? 'bg-accent-600 text-white' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'}`} onClick={() => setFilter(f)}>
            {f.replace('_', ' ')}
          </button>
        ))}
      </div>
      {runs.error && <ErrorNote message={runs.error} />}
      {runs.data && runs.data.length === 0 && <EmptyNote>No runs here yet. The fixture panel can push one.</EmptyNote>}
      {runs.data && runs.data.length > 0 && (
        <table className="card w-full overflow-hidden" aria-label="Runs">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              <th className="th">Run</th>
              <th className="th">Status</th>
              <th className="th">Commit</th>
              <th className="th">Trigger</th>
              <th className="th">Jobs</th>
              <th className="th">Duration</th>
              <th className="th">Started</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {runs.data.map((run) => (
              <tr key={run.id} className="hover:bg-slate-50">
                <td className="td">
                  <Link to="/runs/$runId" params={{ runId: run.id }} className="link">
                    #{run.number} {run.workflowName}
                  </Link>
                  {run.runAttempt > 1 && <span className="ml-1.5 text-xs text-slate-500">run attempt {run.runAttempt}</span>}
                </td>
                <td className="td">
                  <StatusChip status={run.status} />
                </td>
                <td className="td max-w-[220px]">
                  <span className="font-mono text-xs">{shortSha(run.commitSha)}</span>
                  <div className="truncate text-xs text-slate-500">{run.commitMessage}</div>
                </td>
                <td className="td text-xs">
                  {run.isFork && (
                    <span className="chip mr-1 bg-orange-100 text-orange-800">
                      <GitForkIcon className="h-3 w-3" /> fork
                    </span>
                  )}
                  {run.eventType === 'pull_request' ? `PR #${run.prNumber}` : `push to ${run.branch}`}
                  <div className="text-slate-500">
                    {run.sender}
                    {run.redeliveries > 0 && ` · delivered ${run.redeliveries + 1}×`}
                  </div>
                </td>
                <td className="td text-xs">
                  <JobCounts counts={run.jobCounts} />
                </td>
                <td className="td num whitespace-nowrap text-xs">{duration(run.startedAt, run.finishedAt)}</td>
                <td className="td whitespace-nowrap text-xs">{timeAgo(run.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
