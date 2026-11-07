import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { ChatIcon, DocIcon, GaugeIcon, LibraryIcon, LogoutIcon, UsersIcon } from '@/components/icons'
import { useAuthStore } from '@/stores/auth-store'

const MEMBER_NAV = [
  { to: '/documents', label: 'Library', Icon: LibraryIcon },
  { to: '/ask', label: 'Ask', Icon: ChatIcon },
  { to: '/groups', label: 'Groups', Icon: UsersIcon },
] as const

const OPERATOR_NAV = [{ to: '/ops', label: 'Operations', Icon: GaugeIcon }] as const

const ROLE_LABEL = { member: 'member', org_admin: 'org admin', operator: 'operator' } as const

export function AppShell({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const nav = user?.role === 'operator' ? OPERATOR_NAV : MEMBER_NAV
  const link = 'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:text-white'
  return (
    <div className="flex h-screen overflow-hidden">
      <nav className="flex w-56 shrink-0 flex-col bg-slate-900 px-3 py-4" aria-label="Main">
        <div className="mb-6 flex items-center gap-2 px-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-600 text-white">
            <DocIcon className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-semibold text-white">Document Q&amp;A</div>
            <div className="text-[11px] text-slate-400">{user?.orgName ?? 'Platform operations'}</div>
          </div>
        </div>
        <div className="space-y-1">
          {nav.map(({ to, label, Icon }) => (
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
              {user?.username} · {user ? ROLE_LABEL[user.role] : ''}
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
