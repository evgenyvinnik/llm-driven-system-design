import { Link, useNavigate } from '@tanstack/react-router'
import { LogoutIcon, TerminalIcon } from '@/components/icons'
import { useAuth } from '@/stores/auth-store'
import { useRuns } from '@/stores/runs-store'
import { ActiveRunsIndicator } from './ActiveRunsIndicator'

const NAV_LINK = 'rounded-md px-2.5 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900'
const NAV_ACTIVE = 'bg-slate-100 text-slate-900'

export function AppHeader() {
  const user = useAuth((s) => s.user)
  const logout = useAuth((s) => s.logout)
  const resetRuns = useRuns((s) => s.reset)
  const navigate = useNavigate()

  async function handleLogout() {
    await logout()
    resetRuns()
    void navigate({ to: '/login' })
  }

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white">
      <div className="flex h-14 items-center gap-6 px-5">
        <Link to="/" className="flex items-center gap-2 font-semibold text-slate-900">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent-600 text-white">
            <TerminalIcon className="h-4 w-4" />
          </span>
          Prompt Playground
        </Link>
        <nav className="flex items-center gap-1">
          <Link to="/" className={NAV_LINK} activeProps={{ className: NAV_ACTIVE }} activeOptions={{ exact: true }}>
            Prompts
          </Link>
          <Link to="/presets" className={NAV_LINK} activeProps={{ className: NAV_ACTIVE }}>
            Presets
          </Link>
          {user?.role === 'admin' && (
            <Link to="/admin" className={NAV_LINK} activeProps={{ className: NAV_ACTIVE }}>
              Admin
            </Link>
          )}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <ActiveRunsIndicator />
          {user && (
            <div className="text-right leading-tight">
              <div className="text-sm font-medium text-slate-900">{user.displayName}</div>
              <div className="text-xs text-slate-500">{user.workspaceName}</div>
            </div>
          )}
          <button className="btn-ghost" onClick={handleLogout} title="Sign out">
            <LogoutIcon />
          </button>
        </div>
      </div>
    </header>
  )
}
