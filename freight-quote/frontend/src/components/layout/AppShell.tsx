import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { ChartIcon, GaugeIcon, LayersIcon, ListIcon, LogoutIcon, QuoteIcon } from '@/components/icons'
import { useAuthStore } from '@/stores/auth-store'
import type { Role } from '@/types'

const NAV: Array<{ to: string; label: string; Icon: typeof QuoteIcon; roles: Role[] }> = [
  { to: '/', label: 'Quotes', Icon: QuoteIcon, roles: ['customer', 'ops', 'admin'] },
  { to: '/ops', label: 'Operations', Icon: GaugeIcon, roles: ['ops', 'admin'] },
  { to: '/events', label: 'Event log', Icon: ListIcon, roles: ['ops', 'admin'] },
  { to: '/streams', label: 'Streams & DLQ', Icon: LayersIcon, roles: ['ops', 'admin'] },
  { to: '/analytics', label: 'Analytics', Icon: ChartIcon, roles: ['ops', 'admin'] },
]

const ROLE_LABEL: Record<Role, string> = { customer: 'Customer', ops: 'Quote platform ops', admin: 'Pricing admin' }

export function AppShell({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const link = 'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:text-white'
  return (
    <div className="flex h-screen overflow-hidden">
      <nav className="flex w-56 shrink-0 flex-col bg-slate-900 px-3 py-4" aria-label="Main">
        <div className="mb-6 px-2">
          <div className="text-sm font-semibold text-white">Freight Quotes</div>
          <div className="text-xs text-slate-400">Rate inquiry service (practice build)</div>
        </div>
        <div className="space-y-1">
          {NAV.filter((n) => user && n.roles.includes(user.role)).map(({ to, label, Icon }) => (
            <Link key={to} to={to} className={link} activeOptions={{ exact: to === '/' }} activeProps={{ className: `${link} !bg-slate-800 !text-white` }}>
              <Icon className="h-4 w-4" /> {label}
            </Link>
          ))}
        </div>
        <div className="flex-1" />
        <div className="flex items-center justify-between border-t border-slate-800 px-2 pt-3 text-xs text-slate-400">
          <div>
            <div className="font-medium text-slate-200">{user?.displayName}</div>
            <div>{user?.customerName ?? (user && ROLE_LABEL[user.role])}</div>
          </div>
          <button type="button" onClick={() => void logout()} className="rounded p-1.5 hover:bg-slate-800 hover:text-white" title="Sign out">
            <LogoutIcon className="h-4 w-4" />
          </button>
        </div>
      </nav>
      <main className="relative min-w-0 flex-1 overflow-hidden bg-slate-50">{children}</main>
    </div>
  )
}
