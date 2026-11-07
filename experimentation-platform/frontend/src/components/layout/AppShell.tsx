import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { FlaskIcon, FlagIcon, ListIcon, LockIcon, LogoutIcon, RadioIcon } from '@/components/icons'
import { useAuthStore } from '@/stores/auth-store'
import { EnvSwitcher } from './EnvSwitcher'

const NAV = [
  { to: '/flags', label: 'Flags & experiments', Icon: FlagIcon },
  { to: '/clients', label: 'Live SDK clients', Icon: RadioIcon },
  { to: '/audit', label: 'Audit log', Icon: ListIcon },
] as const

export function AppShell({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const link = 'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:text-white'
  return (
    <div className="flex h-screen overflow-hidden">
      <nav className="flex w-60 shrink-0 flex-col bg-slate-900 px-3 py-4" aria-label="Main">
        <div className="mb-5 flex items-center gap-2 px-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-600 text-white">
            <FlaskIcon className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-semibold text-white">Experiments</div>
            <div className="text-[11px] text-slate-400">Flags, rollouts, A/B tests</div>
          </div>
        </div>
        <div className="mb-4 px-1">
          <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Environment</div>
          <EnvSwitcher />
        </div>
        <div className="space-y-1">
          {NAV.map(({ to, label, Icon }) => (
            <Link key={to} to={to} className={link} activeProps={{ className: `${link} !bg-slate-800 !text-white` }}>
              <Icon className="h-4 w-4" /> <span className="flex-1">{label}</span>
            </Link>
          ))}
        </div>
        <div className="flex-1" />
        {user?.role === 'viewer' && (
          <div className="mb-2 flex items-start gap-2 rounded-md bg-slate-800 px-3 py-2 text-[11px] text-slate-300">
            <LockIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Read-only: viewers can see everything but change nothing.
          </div>
        )}
        <div className="flex items-center justify-between rounded-md px-3 py-2 text-sm text-slate-300">
          <div>
            <div className="font-medium text-white">{user?.displayName}</div>
            <div className="text-xs text-slate-400">
              {user?.username} · {user?.role}
            </div>
          </div>
          <button type="button" className="rounded p-1.5 hover:bg-slate-800" onClick={() => void logout()} title="Sign out">
            <LogoutIcon className="h-4 w-4" />
          </button>
        </div>
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto bg-slate-50">{children}</main>
    </div>
  )
}
