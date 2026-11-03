import { useEffect } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { Link, Outlet, createRootRouteWithContext, useNavigate, useRouterState } from '@tanstack/react-router'
import { FreshnessLabel } from '../components/layout/FreshnessLabel'
import { ExportProgress } from '../components/widgets/ExportMenu'
import { LogoutIcon, SpinnerIcon } from '../components/icons'
import { useSession } from '../stores/session'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Root })

const NAV = [
  { to: '/', label: 'Dashboard' },
  { to: '/definitions', label: 'Definitions' },
  { to: '/pipeline', label: 'Pipeline' },
  { to: '/exports', label: 'Exports' },
] as const

function Root() {
  const { status, user, orgs, load, logout } = useSession()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const searchOrg = useRouterState({ select: (s) => (s.location.search as { org?: string }).org })

  useEffect(() => {
    if (status === 'unknown') load().catch(() => undefined)
  }, [status, load])
  useEffect(() => {
    if (status === 'signed-out' && pathname !== '/login') navigate({ to: '/login' })
  }, [status, pathname, navigate])

  if (pathname === '/login') return <Outlet />
  if (status !== 'signed-in' || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center text-ink-2">
        <SpinnerIcon className="h-5 w-5" />
      </div>
    )
  }

  const current = orgs.find((o) => o.orgId === searchOrg) ?? orgs[0]
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b bg-surface" style={{ borderColor: 'var(--border)' }}>
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
          <span className="text-sm font-semibold">Chat Analytics</span>
          <nav className="flex gap-1 text-sm">
            {NAV.map((n) => (
              <Link key={n.to} to={n.to} search={n.to === '/' && current ? { org: current.orgId } : undefined} className="rounded px-2 py-1 text-ink-2 hover:bg-plane [&.active]:bg-plane [&.active]:font-medium [&.active]:text-ink">
                {n.label}
              </Link>
            ))}
          </nav>
          {current && (
            <select
              className="input w-auto py-1 text-xs"
              value={current.orgId}
              aria-label="Organization"
              onChange={(e) => navigate({ to: '/', search: { org: e.target.value } })}
            >
              {orgs.map((o) => (
                <option key={o.orgId} value={o.orgId}>
                  {o.orgName} · {o.role}
                </option>
              ))}
            </select>
          )}
          <div className="ml-auto flex items-center gap-3">
            {current && <FreshnessLabel org={current.orgId} timeZone={current.timeZone} />}
            <span className="text-xs text-ink-2">
              {user.displayName}
              {current && <span className="badge ml-1.5 bg-plane text-ink-2">{current.role}</span>}
            </span>
            <button
              type="button"
              className="btn-ghost px-2"
              aria-label="Sign out"
              onClick={async () => {
                await logout()
                // Nothing cached for one user may be shown to the next.
                queryClient.clear()
                navigate({ to: '/login' })
              }}
            >
              <LogoutIcon />
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1500px] px-4 py-4">
        <Outlet />
      </main>
      <ExportProgress />
    </div>
  )
}
