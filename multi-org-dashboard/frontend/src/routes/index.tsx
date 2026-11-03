import { createFileRoute, Navigate } from '@tanstack/react-router'
import { lastOrgKey, useAuth } from '@/stores/auth-store'

export const Route = createFileRoute('/')({ component: Home })

function readLastOrg(userId: string): string | null {
  try {
    return localStorage.getItem(lastOrgKey(userId))
  } catch {
    return null
  }
}

/** Opens the org the user was last in, if they still belong to it. */
function Home() {
  const user = useAuth((s) => s.user)
  const orgs = useAuth((s) => s.orgs)
  if (!user) return null
  const last = readLastOrg(user.id)
  const target = orgs.find((o) => o.id === last) ?? orgs[0]
  if (!target) {
    return (
      <div className="mx-auto max-w-md py-24 text-center">
        <h1 className="text-lg font-semibold">You're not in any organization yet</h1>
        <p className="mt-1 text-sm text-slate-600">Ask an admin to invite you, then open the link from the invitation.</p>
      </div>
    )
  }
  return <Navigate to="/orgs/$orgId" params={{ orgId: target.id }} replace />
}
