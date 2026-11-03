import { useEffect } from 'react'
import { createRootRoute, Navigate, Outlet, useRouterState } from '@tanstack/react-router'
import { Toasts } from '@/components/layout'
import { Loading } from '@/components/shared'
import { openEventStream } from '@/services/events'
import { useAuth } from '@/stores/auth-store'

export const Route = createRootRoute({ component: RootLayout })

const PUBLIC_PREFIXES = ['/login', '/share/', '/invite/']

function RootLayout() {
  const status = useAuth((s) => s.status)
  const init = useAuth((s) => s.init)
  const location = useRouterState({ select: (s) => s.location })
  const isPublic = PUBLIC_PREFIXES.some((p) => location.pathname.startsWith(p))

  useEffect(() => {
    void init()
  }, [init])

  // One event stream per tab, for every org; it doesn't reconnect on org switches.
  useEffect(() => {
    if (status !== 'authenticated') return
    return openEventStream()
  }, [status])

  if (status === 'loading' && !isPublic) return <Loading label="Starting…" />
  if (status === 'unauthenticated' && !isPublic) {
    // 401: sign in again, then come back to exactly this URL (filters and open panes included).
    return <Navigate to="/login" search={{ redirect: location.href }} replace />
  }
  return (
    <div className="min-h-screen bg-slate-50">
      <Outlet />
      <Toasts />
    </div>
  )
}
