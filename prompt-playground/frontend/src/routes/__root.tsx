import { useEffect } from 'react'
import { createRootRoute, Outlet, useRouterState } from '@tanstack/react-router'
import { AppHeader, Toasts } from '@/components/layout'
import { api } from '@/services/api'
import { useAuth } from '@/stores/auth-store'
import { useRuns } from '@/stores/runs-store'

export const Route = createRootRoute({ component: RootLayout })

function RootLayout() {
  const status = useAuth((s) => s.status)
  const init = useAuth((s) => s.init)
  const follow = useRuns((s) => s.follow)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const bare = pathname === '/login' || pathname.startsWith('/s/')

  useEffect(() => {
    void init()
  }, [init])

  // After sign-in (or a refresh), reattach to runs still in progress.
  useEffect(() => {
    if (status !== 'authenticated') return
    api
      .activeRuns()
      .then(({ runs }) => runs.forEach((run) => follow(run, run.promptTitle)))
      .catch(() => undefined)
  }, [status, follow])

  return (
    <div className="min-h-screen bg-slate-50">
      {!bare && status === 'authenticated' && <AppHeader />}
      <Outlet />
      <Toasts />
    </div>
  )
}
