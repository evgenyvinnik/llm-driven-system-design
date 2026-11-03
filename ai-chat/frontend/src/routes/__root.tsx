import { useEffect, useRef } from 'react'
import { createRootRoute, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { SpinnerIcon } from '@/components/icons'
import { LiveAnnouncer, Toasts } from '@/components/layout/Feedback'
import { Sidebar } from '@/components/layout/Sidebar'
import { connectDeviceEvents } from '@/services/device-events'
import { useAuth } from '@/stores/auth-store'
import { useCatalog } from '@/stores/catalog-store'
import { useConnectivity } from '@/stores/connectivity-store'
import { useConversations } from '@/stores/conversations-store'

export const Route = createRootRoute({ component: RootLayout })

function RootLayout() {
  const status = useAuth((s) => s.status)
  const init = useAuth((s) => s.init)
  const online = useConnectivity((s) => s.online)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const navigate = useNavigate()
  const isLogin = pathname === '/login'

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    if (status === 'anonymous' && !isLogin) void navigate({ to: '/login' })
    if (status === 'authenticated' && isLogin) void navigate({ to: '/' })
  }, [status, isLogin, navigate])

  // Signed in: load the sidebar and open the device-sync stream. The stream's
  // "ready" event triggers a reconciliation (active generations, fresh list).
  useEffect(() => {
    if (status !== 'authenticated') return
    void useConversations.getState().loadList()
    void useCatalog.getState().load()
    return connectDeviceEvents()
  }, [status])

  // Back online after an outage: refresh what is on screen from the server.
  const wasOnline = useRef(online)
  useEffect(() => {
    if (online && !wasOnline.current && status === 'authenticated') {
      const conversations = useConversations.getState()
      void conversations.loadList()
      if (conversations.viewingId) void conversations.loadThread(conversations.viewingId)
    }
    wasOnline.current = online
  }, [online, status])

  if (status === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center text-slate-400">
        <SpinnerIcon className="h-5 w-5" />
      </div>
    )
  }

  if (isLogin || status !== 'authenticated') {
    return (
      <>
        <Outlet />
        <LiveAnnouncer />
      </>
    )
  }

  return (
    <div className="flex h-screen overflow-hidden bg-white">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </main>
      <Toasts />
      <LiveAnnouncer />
    </div>
  )
}
