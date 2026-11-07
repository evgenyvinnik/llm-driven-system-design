import { Outlet, createRootRoute, useNavigate, useRouterState } from '@tanstack/react-router'
import { useEffect } from 'react'
import { AppShell } from '@/components/layout/AppShell'
import { Loading } from '@/components/shared/Loading'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createRootRoute({ component: Root })

function Root() {
  const user = useAuthStore((s) => s.user)
  const checked = useAuthStore((s) => s.checked)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const navigate = useNavigate()
  const onLogin = pathname === '/login'
  const isOperator = user?.role === 'operator'
  const wrongArea = user ? (isOperator ? pathname !== '/ops' : pathname === '/ops') : false

  useEffect(() => {
    void useAuthStore.getState().check()
  }, [])
  // Redirects happen in an effect, once per auth change, never by rendering <Navigate> while the router settles.
  useEffect(() => {
    if (!checked) return
    if (!user && !onLogin) void navigate({ to: '/login', replace: true })
    else if (user && (onLogin || pathname === '/' || wrongArea)) void navigate({ to: isOperator ? '/ops' : '/documents', replace: true })
  }, [checked, user, onLogin, pathname, navigate, isOperator, wrongArea])

  if (!checked || (!user && !onLogin) || (user && (onLogin || wrongArea))) return <Loading />
  if (onLogin) return <Outlet />
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}
