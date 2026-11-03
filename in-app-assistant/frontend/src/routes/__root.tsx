import { Outlet, createRootRoute, useNavigate, useRouterState } from '@tanstack/react-router'
import { useEffect } from 'react'
import { AppShell } from '@/components/layout/AppShell'
import { Loading } from '@/components/shared/Loading'
import { setNavigator } from '@/services/client-tools'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createRootRoute({ component: Root })

function Root() {
  const user = useAuthStore((s) => s.user)
  const checked = useAuthStore((s) => s.checked)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const navigate = useNavigate()
  const onLogin = pathname === '/login'

  useEffect(() => {
    void useAuthStore.getState().check()
  }, [])
  useEffect(() => {
    // The open_item client tool navigates through the router like any link.
    setNavigator((to) => {
      const url = new URL(to, window.location.origin)
      void navigate({ to: url.pathname, search: Object.fromEntries(url.searchParams) as never })
    })
  }, [navigate])
  // Redirects happen in an effect, once per auth change. Rendering <Navigate> from the root
  // route while the router is still settling the first location re-entered the router store
  // and hit React's update-depth limit.
  useEffect(() => {
    if (!checked) return
    if (!user && !onLogin) void navigate({ to: '/login', replace: true })
    else if (user && onLogin) void navigate({ to: '/mail', replace: true })
  }, [checked, user, onLogin, navigate])

  if (!checked || (!user && !onLogin) || (user && onLogin)) return <Loading />
  if (onLogin) return <Outlet />
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}
