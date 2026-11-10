import { Link, useNavigate } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { GaugeIcon, LogoIcon, LogoutIcon, RouteIcon, TerminalIcon } from '@/components/icons'
import { useAuthStore } from '@/stores/auth-store'

const linkClass = 'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900'
const activeClass = 'bg-slate-100 text-slate-900'

export function AppShell({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const navigate = useNavigate()

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4">
          <Link to="/console" className="flex items-center gap-2 font-semibold text-slate-900">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-600 text-white">
              <LogoIcon className="h-4 w-4" />
            </span>
            Inference API
          </Link>
          <nav className="flex items-center gap-1" aria-label="Main">
            <Link to="/console" className={linkClass} activeProps={{ className: activeClass }}>
              <TerminalIcon /> Console
            </Link>
            {user?.isAdmin === true && (
              <>
                <Link to="/admin" className={linkClass} activeProps={{ className: activeClass }}>
                  <GaugeIcon /> Admin
                </Link>
                <Link to="/routing" className={linkClass} activeProps={{ className: activeClass }}>
                  <RouteIcon /> Routing
                </Link>
              </>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="hidden text-slate-600 sm:inline">
              {user?.displayName}
              {user?.isAdmin === true && <span className="chip ml-2 bg-slate-900 text-white">admin</span>}
            </span>
            <button
              type="button"
              className="btn-ghost"
              onClick={async () => {
                await logout()
                void navigate({ to: '/login' })
              }}
            >
              <LogoutIcon /> Sign out
            </button>
          </div>
        </div>
      </header>
      {children}
    </div>
  )
}
