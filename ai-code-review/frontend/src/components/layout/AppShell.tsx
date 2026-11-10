import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { BeakerIcon, InboxIcon, ListIcon, LogoutIcon, PullIcon, ScaleIcon, ShieldCheckIcon, SlidersIcon } from '@/components/icons'
import { useAuthStore } from '@/stores/auth-store'

const NAV = [
  { to: '/prs', label: 'Pull requests', Icon: PullIcon },
  { to: '/escalations', label: 'Escalations', Icon: InboxIcon },
  { to: '/audit', label: 'Audit log', Icon: ListIcon },
  { to: '/evaluation', label: 'Evaluation', Icon: ScaleIcon },
  { to: '/settings', label: 'Repo settings', Icon: SlidersIcon },
  { to: '/fixtures', label: 'Fixture panel', Icon: BeakerIcon },
] as const

export function AppShell({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const link = 'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:text-white'
  return (
    <div className="flex min-h-screen">
      <div className="w-52 shrink-0 bg-slate-900">
        <nav className="sticky top-0 flex h-screen flex-col px-3 py-4" aria-label="Main">
          <div className="mb-6 flex items-center gap-2 px-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-600 text-white">
              <ShieldCheckIcon className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold text-white">AI Code Review</div>
              <div className="text-[11px] text-slate-400">{user?.orgName ?? 'All orgs'}</div>
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
              <div className="text-xs text-slate-400">{user?.role.replace('_', ' ')}</div>
            </div>
            <button type="button" className="rounded p-1.5 hover:bg-slate-800" onClick={() => void logout()} title="Sign out">
              <LogoutIcon className="h-4 w-4" />
            </button>
          </div>
        </nav>
      </div>
      <main className="min-w-0 flex-1 bg-slate-50">{children}</main>
    </div>
  )
}
