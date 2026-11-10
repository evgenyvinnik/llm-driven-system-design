import { createFileRoute, Link } from '@tanstack/react-router'
import { AlertIcon, RepoIcon } from '@/components/icons'
import { EmptyNote, ErrorNote, Loading } from '@/components/shared/Feedback'
import { StatusChip } from '@/components/shared/StatusChip'
import { shortSha, timeAgo } from '@/lib/format'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'

export const Route = createFileRoute('/repos/')({ component: Repos })

function Repos() {
  const { data, error, loading } = usePoll(api.repos, 3000)
  if (loading && !data) return <Loading />
  return (
    <div className="page">
      <h1 className="h1">Repositories</h1>
      {error && <ErrorNote message={error} />}
      {data && data.length === 0 && <EmptyNote>You are not a member of any repository.</EmptyNote>}
      {data && data.length > 0 && (
        <table className="card w-full overflow-hidden" aria-label="Repositories">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              <th className="th">Repository</th>
              <th className="th">Latest run</th>
              <th className="th">Runs</th>
              <th className="th">Jobs running / limit</th>
              <th className="th">Queued</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <td className="td">
                  <Link to="/repos/$repoId" params={{ repoId: r.id }} className="link flex items-center gap-2">
                    <RepoIcon className="h-4 w-4 text-slate-400" /> {r.fullName}
                  </Link>
                  <div className="ml-6 text-xs text-slate-500">
                    {r.org} · {r.role === 'maintainer' ? 'maintainer' : 'read-only'}
                  </div>
                </td>
                <td className="td">
                  {r.lastRun ? (
                    <Link to="/runs/$runId" params={{ runId: r.lastRun.id }} className="flex flex-wrap items-center gap-2 hover:underline">
                      <StatusChip status={r.lastRun.status} />
                      <span>#{r.lastRun.number}</span>
                      <span className="font-mono text-xs text-slate-500">{shortSha(r.lastRun.commitSha)}</span>
                      <span className="text-xs text-slate-500">{timeAgo(r.lastRun.createdAt)}</span>
                    </Link>
                  ) : (
                    '—'
                  )}
                  {r.attentionJobs > 0 && (
                    <div className="mt-1 flex items-center gap-1 text-xs font-medium text-amber-800">
                      <AlertIcon className="h-3 w-3" /> {r.attentionJobs} job{r.attentionJobs === 1 ? '' : 's'} with an unknown outcome
                    </div>
                  )}
                </td>
                <td className="td num">{r.totalRuns}</td>
                <td className="td num">
                  {r.runningJobs} / {r.maxConcurrentJobs}
                </td>
                <td className="td num">{r.queuedJobs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
