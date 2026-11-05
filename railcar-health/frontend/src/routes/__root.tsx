import { Outlet, createRootRoute, useNavigate, useRouterState } from '@tanstack/react-router'
import { useEffect } from 'react'
import { AppShell } from '@/components/layout/AppShell'
import { Loading } from '@/components/shared/Loading'
import { homeFor } from '@/lib/navigation'
import { api } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'
import { useClockStore } from '@/stores/clock-store'

export const Route = createRootRoute({ component: Root })

export function Root() {
  const user = useAuthStore((s) => s.user)
  const checked = useAuthStore((s) => s.checked)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const navigate = useNavigate()
  const onLogin = pathname === '/login'

  useEffect(() => {
    void useAuthStore.getState().check()
    void api.clock().then(useClockStore.getState().update).catch(() => undefined)
  }, [])
  // Redirects happen in an effect, once per auth change, not by rendering <Navigate> while the router settles.
  useEffect(() => {
    if (!checked) return
    if (!user && !onLogin) void navigate({ to: '/login', replace: true })
    else if (user && (onLogin || pathname === '/')) void navigate({ to: homeFor(user.role), replace: true })
  }, [checked, user, onLogin, pathname, navigate])

  if (!checked || (!user && !onLogin) || (user && onLogin)) return <Loading />
  if (onLogin) return <Outlet />
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}
