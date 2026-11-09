import { Link } from '@tanstack/react-router'
import type { RepositoryDetail } from '@/types'
import { RepoIcon } from '@/components/icons'

export function RepoNav({ repo }: { repo: RepositoryDetail }) {
  const tab = 'border-b-2 border-transparent px-3 py-2 text-sm font-medium text-slate-500 hover:text-slate-800'
  const active = { className: `${tab} !border-accent-600 !text-accent-700` }
  return (
    <div>
      <div className="flex items-center gap-2">
        <RepoIcon className="h-5 w-5 text-slate-400" />
        <h1 className="h1">{repo.fullName}</h1>
        <span className={`chip ${repo.role === 'maintainer' ? 'bg-accent-100 text-accent-700' : 'bg-slate-200 text-slate-600'}`}>{repo.role === 'maintainer' ? 'maintainer' : 'read-only'}</span>
        <span className="chip bg-slate-100 text-slate-600" title="Jobs of this repository that may hold a lease at once">
          limit {repo.maxConcurrentJobs} concurrent jobs
        </span>
      </div>
      <nav className="mt-3 flex gap-1 border-b border-slate-200" aria-label="Repository">
        <Link to="/repos/$repoId" params={{ repoId: repo.id }} activeOptions={{ exact: true }} className={tab} activeProps={active}>
          Runs
        </Link>
        <Link to="/repos/$repoId/environments" params={{ repoId: repo.id }} className={tab} activeProps={active}>
          Environments
        </Link>
        <Link to="/repos/$repoId/secrets" params={{ repoId: repo.id }} className={tab} activeProps={active}>
          Secrets
        </Link>
      </nav>
    </div>
  )
}
