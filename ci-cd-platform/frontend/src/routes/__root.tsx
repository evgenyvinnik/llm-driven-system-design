import { Outlet, createRootRoute, useNavigate, useRouterState } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import { AppShell } from '@/components/layout/AppShell'
import { Loading } from '@/components/shared/Feedback'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createRootRoute({ component: Root })

function Root() {
  const user = useAuthStore((s) => s.user)
  const checked = useAuthStore((s) => s.checked)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const navigate = useNavigate()
  const onLogin = pathname === '/login'
  // A run link from chat should land on that run after signing in, not on the repository list.
  const returnTo = useRef<string | null>(null)
  // After an explicit sign-out the next person starts fresh, not on the previous person's page.
  const wasSignedIn = useRef(false)

  useEffect(() => {
    void useAuthStore.getState().check()
  }, [])
  // Redirects happen in an effect, once per auth change, never by rendering <Navigate> while the router settles.
  useEffect(() => {
    if (!checked) return
    if (user) wasSignedIn.current = true
    if (!user && !onLogin) {
      if (pathname !== '/' && !wasSignedIn.current) returnTo.current = pathname
      void navigate({ to: '/login', replace: true })
    } else if (user && (onLogin || pathname === '/')) {
      const target = returnTo.current ?? '/repos'
      returnTo.current = null
      void navigate({ to: target, replace: true })
    }
  }, [checked, user, onLogin, pathname, navigate])

  if (!checked || (!user && !onLogin) || (user && onLogin)) return <Loading />
  if (onLogin) return <Outlet />
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}
