import { createFileRoute, Link } from '@tanstack/react-router'
import { KeyIcon, ShieldIcon, TrashIcon } from '@/components/icons'
import { RepoNav } from '@/components/repo/RepoNav'
import { SecretForm } from '@/components/repo/SecretForm'
import { EmptyNote, ErrorNote, Loading, Panel } from '@/components/shared/Feedback'
import { timeAgo } from '@/lib/format'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'

export const Route = createFileRoute('/repos/$repoId/secrets')({ component: Secrets })

function Secrets() {
  const { repoId } = Route.useParams()
  const repo = usePoll(() => api.repo(repoId), 0, [repoId])
  const secrets = usePoll(() => api.secrets(repoId), 5000, [repoId])
  const environments = usePoll(() => api.environments(repoId), 0, [repoId])
  const releases = usePoll(() => api.releases(repoId), 5000, [repoId])
  if (repo.errorStatus === 404) return <main className="page"><ErrorNote message="This repository does not exist, or you do not have access to it." /></main>
  if (!repo.data) return <Loading />
  const canManage = repo.data.role === 'maintainer'
  return (
    <div className="page">
      <RepoNav repo={repo.data} />
      <div className="flex items-start gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
        <ShieldIcon className="mt-0.5 h-4 w-4 shrink-0 text-accent-600" />
        <span>
          Values are encrypted at rest (AES-256-GCM) and delivered only when a job allowed to have them is claimed. They are never returned by this API, and pull requests from forks never receive them.
        </span>
      </div>
      {canManage && (
        <Panel title="Add or rotate a secret">
          <SecretForm repoId={repoId} environments={environments.data ?? []} onSaved={secrets.reload} />
        </Panel>
      )}
      <Panel title="Secrets" label="Secrets list">
        {secrets.data && secrets.data.length === 0 && <div className="p-4"><EmptyNote>No secrets in this repository.</EmptyNote></div>}
        {secrets.data && secrets.data.length > 0 && (
          <table className="w-full" aria-label="Secrets">
            <thead className="border-b border-slate-100">
              <tr>
                <th className="th">Name</th>
                <th className="th">Scope</th>
                <th className="th">Value</th>
                <th className="th">Released</th>
                <th className="th">Updated</th>
                {canManage && <th className="th" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {secrets.data.map((s) => (
                <tr key={s.id}>
                  <td className="td">
                    <span className="flex items-center gap-1.5 font-mono text-xs">
                      <KeyIcon className="h-3.5 w-3.5 text-slate-400" /> {s.name}
                    </span>
                  </td>
                  <td className="td">
                    <span className={`chip ${s.environment ? 'bg-violet-100 text-violet-800' : 'bg-slate-100 text-slate-600'}`}>{s.environment ? `environment: ${s.environment}` : 'repository'}</span>
                  </td>
                  <td className="td font-mono text-xs text-slate-400" title="Values are write-only">
                    ••••••••
                  </td>
                  <td className="td text-xs">
                    {s.releaseCount} time{s.releaseCount === 1 ? '' : 's'}
                    {s.lastReleasedAt && <span className="text-slate-500"> · last {timeAgo(s.lastReleasedAt)}</span>}
                  </td>
                  <td className="td text-xs text-slate-500">
                    {timeAgo(s.updatedAt)} by {s.createdBy}
                  </td>
                  {canManage && (
                    <td className="td text-right">
                      <button type="button" className="btn-ghost !p-1" title={`Delete ${s.name}`} aria-label={`Delete ${s.name}`} onClick={() => void api.deleteSecret(repoId, s.id).then(secrets.reload)}>
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <Panel title="Release audit" aside={<span className="text-xs text-slate-500">every release, with its run, job and attempt</span>} label="Release audit">
        {releases.data && releases.data.length === 0 && <div className="p-4"><EmptyNote>Nothing has been released yet.</EmptyNote></div>}
        {releases.data && releases.data.length > 0 && (
          <table className="w-full" aria-label="Secret releases">
            <thead className="border-b border-slate-100">
              <tr>
                <th className="th">When</th>
                <th className="th">Secret</th>
                <th className="th">Scope</th>
                <th className="th">Run</th>
                <th className="th">Job</th>
                <th className="th">Attempt</th>
                <th className="th">Runner</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {releases.data.map((r) => (
                <tr key={r.id}>
                  <td className="td whitespace-nowrap text-xs">{timeAgo(r.releasedAt)}</td>
                  <td className="td font-mono text-xs">{r.secretName}</td>
                  <td className="td text-xs">{r.scope}</td>
                  <td className="td text-xs">
                    <Link to="/runs/$runId" params={{ runId: r.runId }} className="link">
                      #{r.runNumber}
                    </Link>
                  </td>
                  <td className="td text-xs">
                    <Link to="/runs/$runId/jobs/$jobId" params={{ runId: r.runId, jobId: r.jobId }} className="link">
                      {r.jobKey}
                    </Link>
                  </td>
                  <td className="td num text-xs">{r.attempt}</td>
                  <td className="td text-xs">{r.runnerName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}
