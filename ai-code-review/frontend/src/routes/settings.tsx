import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ModePanel } from '@/components/settings/ModePanel'
import { PolicyForm } from '@/components/settings/PolicyForm'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'
import { canAdmin, useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/settings')({
  component: Settings,
  validateSearch: (s: Record<string, unknown>) => ({ repo: typeof s.repo === 'string' ? s.repo : undefined }),
})

function Settings() {
  const user = useAuthStore((s) => s.user)
  const navigate = useNavigate()
  const { repo: wanted } = Route.useSearch()
  const repos = usePoll(() => api.repos(), 15000)
  const id = wanted ?? repos.data?.repos[0]?.id
  const detail = usePoll(() => (id ? api.repo(id) : Promise.resolve(null)), 4000, [id])
  return (
    <div className="page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="h1">Repository settings</h1>
          <p className="text-sm text-slate-500">{canAdmin(user) ? 'Mode, kill switch and policy.' : 'Read-only for reviewers: repo admins can change these.'}</p>
        </div>
        <select aria-label="Repository" className="input !w-56" value={id ?? ''} onChange={(e) => void navigate({ to: '/settings', search: { repo: e.target.value } })}>
          {repos.data?.repos.map((r) => <option key={r.id} value={r.id}>{r.fullName}</option>)}
        </select>
      </div>
      {detail.error && <ErrorNote message={detail.error} />}
      {detail.data ? (
        <>
          <ModePanel detail={detail.data} editable={canAdmin(user)} onChange={detail.reload} />
          <PolicyForm key={`${detail.data.repo.id}-${detail.data.repo.settingsVersion}`} repo={detail.data.repo} modelVersions={detail.data.modelVersions} editable={canAdmin(user)} onSaved={detail.reload} />
        </>
      ) : <Loading />}
    </div>
  )
}
