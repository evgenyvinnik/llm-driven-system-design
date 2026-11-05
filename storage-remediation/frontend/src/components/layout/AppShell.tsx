import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { DocIcon, GaugeIcon, ListIcon, LogoutIcon, RocketIcon, ShieldCheckIcon, SlidersIcon, UndoIcon } from '@/components/icons'
import { useAuthStore } from '@/stores/auth-store'
import { NotificationBell } from './NotificationBell'

const NAV = [
  { to: '/posture', label: 'Posture', icon: GaugeIcon },
  { to: '/findings', label: 'Findings', icon: ListIcon },
  { to: '/campaigns', label: 'Campaigns', icon: RocketIcon },
  { to: '/exceptions', label: 'Exceptions', icon: UndoIcon },
  { to: '/controls', label: 'Controls & policy', icon: SlidersIcon },
  { to: '/audit', label: 'Audit log', icon: DocIcon },
] as const

const ROLE_LABEL = { security: 'Security engineer', owner: 'Resource owner', approver: 'Approver' }

export function AppShell({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user)!
  const logout = useAuthStore((s) => s.logout)
  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-700 text-white">
            <ShieldCheckIcon className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-900">Storage Guard</div>
            <div className="text-[11px] text-slate-500">Northwind Holdings</div>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 p-2">
          {NAV.map(({ to, label, icon: Icon }) => (
            <Link key={to} to={to} className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 hover:text-slate-900" activeProps={{ className: 'bg-accent-50 font-medium text-accent-800 hover:bg-accent-50' }}>
              <Icon className="h-4 w-4" /> {label}
            </Link>
          ))}
        </nav>
        <div className="border-t border-slate-100 p-3">
          <div className="text-sm font-medium text-slate-800">{user.displayName}</div>
          <div className="text-xs text-slate-500">
            {ROLE_LABEL[user.role]}
            {user.team ? ` · ${user.team}` : ''}
          </div>
          <button type="button" className="btn-ghost mt-2 w-full justify-start px-2" onClick={() => void logout()}>
            <LogoutIcon /> Sign out
          </button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-end gap-3 border-b border-slate-200 bg-white px-6 py-2">
          <span className="text-xs text-slate-500">{user.role === 'owner' ? `Showing accounts owned by ${user.team}` : 'Showing the whole fleet'}</span>
          <NotificationBell />
        </header>
        <main className="min-w-0 flex-1 p-6">{children}</main>
      </div>
    </div>
  )
}
