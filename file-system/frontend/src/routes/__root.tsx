import { createRootRoute, Outlet } from '@tanstack/react-router'
import { AppHeader, Toasts } from '@/components/layout'

export const Route = createRootRoute({ component: RootLayout })

function RootLayout() {
  return (
    <div className="min-h-screen bg-slate-50">
      <AppHeader />
      <Outlet />
      <Toasts />
    </div>
  )
}
