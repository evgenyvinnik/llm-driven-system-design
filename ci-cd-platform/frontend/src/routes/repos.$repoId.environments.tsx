import { createFileRoute } from '@tanstack/react-router'
import { RepoNav } from '@/components/repo/RepoNav'
import { EnvironmentCard } from '@/components/repo/EnvironmentCard'
import { EmptyNote, ErrorNote, Loading } from '@/components/shared/Feedback'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'

export const Route = createFileRoute('/repos/$repoId/environments')({ component: Environments })

function Environments() {
  const { repoId } = Route.useParams()
  const repo = usePoll(() => api.repo(repoId), 0, [repoId])
  const environments = usePoll(() => api.environments(repoId), 5000, [repoId])
  if (repo.errorStatus === 404) return <main className="page"><ErrorNote message="This repository does not exist, or you do not have access to it." /></main>
  if (!repo.data) return <Loading />
  return (
    <div className="page">
      <RepoNav repo={repo.data} />
      <p className="text-sm text-slate-600">An environment gates the jobs that name it. A protected environment can restrict which branches may enter and require a person to approve each attempt. A pull request from a fork can never enter one.</p>
      {environments.data?.length === 0 && <EmptyNote>No environments configured.</EmptyNote>}
      <div className="grid gap-4 md:grid-cols-2" aria-label="Environments">
        {environments.data?.map((env) => <EnvironmentCard key={env.id} repoId={repoId} environment={env} canManage={repo.data?.role === 'maintainer'} onSaved={environments.reload} />)}
      </div>
    </div>
  )
}
