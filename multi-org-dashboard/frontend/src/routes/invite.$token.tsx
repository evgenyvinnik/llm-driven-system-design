import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { ErrorNote, Loading, RoleBadge } from '@/components/shared'
import { api, ApiError } from '@/services/api'
import { useAuth } from '@/stores/auth-store'

export const Route = createFileRoute('/invite/$token')({ component: InvitePage })

function InvitePage() {
  const { token } = Route.useParams()
  const status = useAuth((s) => s.status)
  const user = useAuth((s) => s.user)
  const refreshOrgs = useAuth((s) => s.refreshOrgs)
  const navigate = useNavigate()
  const [error, setError] = useState<unknown>(null)
  const { data, isPending, error: loadError } = useQuery({ queryKey: ['invitation', token], queryFn: () => api.invitation(token) })

  const accept = async () => {
    try {
      const result = await api.acceptInvitation(token)
      await refreshOrgs()
      void navigate({ to: '/orgs/$orgId', params: { orgId: result.orgId } })
    } catch (err) {
      setError(err)
    }
  }

  if (isPending) return <Loading />
  return (
    <main className="mx-auto max-w-md px-4 py-20">
      <div className="card p-6">
        {loadError || !data ? (
          <ErrorNote error={loadError} notFound="This invitation link isn't valid." />
        ) : (
          <>
            <h1 className="text-lg font-semibold">Join {data.invitation.orgName}</h1>
            <p className="mt-1 text-sm text-slate-600">
              {data.invitation.invitedByName ?? 'An admin'} invited <strong>{data.invitation.email}</strong> as{' '}
              <RoleBadge role={data.invitation.role} />
            </p>
            {data.invitation.status !== 'pending' ? (
              <p className="mt-4 text-sm text-slate-600">This invitation is {data.invitation.status}. Ask for a new one.</p>
            ) : status !== 'authenticated' ? (
              <Link to="/login" search={{ redirect: `/invite/${token}` }} className="btn-primary mt-4">
                Sign in to accept
              </Link>
            ) : (
              <div className="mt-4 space-y-2">
                <p className="text-xs text-slate-500">Signed in as {user?.email}</p>
                <button className="btn-primary" onClick={() => void accept()}>
                  Accept invitation
                </button>
              </div>
            )}
            {error instanceof ApiError && <p className="mt-3 text-sm text-red-700">{error.message}</p>}
          </>
        )}
      </div>
    </main>
  )
}
