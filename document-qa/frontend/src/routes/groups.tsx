import { createFileRoute } from '@tanstack/react-router'
import { GroupCard } from '@/components/groups/GroupCard'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/groups')({ component: Groups })

function Groups() {
  const user = useAuthStore((s) => s.user)
  const data = usePoll(() => api.groups(), 3000)
  const canEdit = user?.role === 'org_admin'
  return (
    <div className="page">
      <div>
        <h1 className="h1">Groups</h1>
        <p className="max-w-3xl text-sm text-slate-500">
          Documents shared with a group are readable by its members. Removing someone takes effect on their next question: the index rows and their
          session are left as they are, and the answer path re-checks membership live before any passage reaches the model.
          {!canEdit && ' Only organization admins can change membership.'}
        </p>
      </div>
      {data.error && <ErrorNote message={data.error} />}
      {!data.data ? (
        <Loading />
      ) : (
        <section aria-label="Groups" className="grid gap-4 md:grid-cols-2">
          {data.data.groups.map((g) => (
            <GroupCard key={g.id} group={g} users={data.data?.users ?? []} canEdit={canEdit} onChange={data.reload} />
          ))}
        </section>
      )}
    </div>
  )
}
