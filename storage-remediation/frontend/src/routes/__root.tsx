import { Outlet, createRootRoute, useNavigate, useRouterState } from '@tanstack/react-router'
import { useEffect } from 'react'
import { AppShell } from '@/components/layout/AppShell'
import { Loading } from '@/components/shared'
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
  // Redirects run in an effect, once per auth change, never during render.
  useEffect(() => {
    if (!checked) return
    if (!user && !onLogin) void navigate({ to: '/login', replace: true })
    else if (user && onLogin) void navigate({ to: '/posture', replace: true })
  }, [checked, user, onLogin, navigate])

  if (!checked || (!user && !onLogin) || (user && onLogin)) return <Loading />
  if (onLogin) return <Outlet />
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}
