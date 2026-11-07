import { Outlet, createRootRoute, useNavigate, useRouterState } from '@tanstack/react-router'
import { useEffect } from 'react'
import { AppShell } from '@/components/layout/AppShell'
import { Loading } from '@/components/shared/Loading'
import { useApplyAppearance } from '@/lib/appearance'
import { appSettings } from '@/stores/app-settings'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createRootRoute({ component: Root })

function Root() {
  const user = useAuthStore((s) => s.user)
  const checked = useAuthStore((s) => s.checked)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const navigate = useNavigate()
  const onLogin = pathname === '/login'
  useApplyAppearance()

  useEffect(() => {
    void useAuthStore.getState().check()
  }, [])
  // This tab's settings client starts once we know who is signed in.
  useEffect(() => {
    if (user) appSettings.getState().start(user.id)
  }, [user])
  // Redirects happen in an effect, once per auth change, not while the router is settling.
  useEffect(() => {
    if (!checked) return
    if (!user && !onLogin) void navigate({ to: '/login', replace: true })
    else if (user && (onLogin || pathname === '/')) void navigate({ to: '/settings', replace: true })
  }, [checked, user, onLogin, pathname, navigate])

  if (!checked || (!user && !onLogin) || (user && (onLogin || pathname === '/'))) {
    return (
      <main>
        <Loading />
      </main>
    )
  }
  if (onLogin) return <Outlet />
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}
