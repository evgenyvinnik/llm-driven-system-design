import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { FlaskIcon, GaugeIcon, GitBranchIcon, LogoutIcon, RepoIcon, ServerIcon } from '@/components/icons'
import { useAuthStore } from '@/stores/auth-store'

const NAV = [
  { to: '/repos', label: 'Repositories', Icon: RepoIcon },
  { to: '/runners', label: 'Runners', Icon: ServerIcon },
  { to: '/ops', label: 'Operations', Icon: GaugeIcon },
  { to: '/fixtures', label: 'Fixture panel', Icon: FlaskIcon },
] as const

/** The document scrolls, not an inner pane, so a full-page screenshot captures the whole thing. */
export function AppShell({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const link = 'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:text-white'
  return (
    <div className="flex min-h-screen">
      {/* The column runs the full page height, and the nav inside it sticks: full-page screenshots stay dark to the bottom. */}
      <div className="w-56 shrink-0 bg-slate-900">
      <nav className="sticky top-0 flex h-screen flex-col px-3 py-4" aria-label="Main">
        <div className="mb-6 flex items-center gap-2 px-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-600 text-white">
            <GitBranchIcon className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-semibold text-white">CI/CD Platform</div>
            <div className="text-[11px] text-slate-400">{user?.orgName}</div>
          </div>
        </div>
        <div className="space-y-1">
          {NAV.map(({ to, label, Icon }) => (
            <Link key={to} to={to} className={link} activeProps={{ className: `${link} !bg-slate-800 !text-white` }}>
              <Icon className="h-4 w-4" /> <span className="flex-1">{label}</span>
            </Link>
          ))}
        </div>
        <div className="flex-1" />
        <div className="flex items-center justify-between rounded-md px-3 py-2 text-sm text-slate-300">
          <div>
            <div className="font-medium text-white">{user?.displayName}</div>
            <div className="text-xs text-slate-400">
              {user?.username}
              {user?.isAdmin ? ' · admin' : ''}
            </div>
          </div>
          <button type="button" className="rounded p-1.5 hover:bg-slate-800" onClick={() => void logout()} title="Sign out" aria-label="Sign out">
            <LogoutIcon className="h-4 w-4" />
          </button>
        </div>
      </nav>
      </div>
      <main className="min-w-0 flex-1 bg-slate-50">{children}</main>
    </div>
  )
}
