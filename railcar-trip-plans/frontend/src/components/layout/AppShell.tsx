import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { AlertIcon, BellIcon, CarIcon, LogoutIcon, RouteIcon, StreamIcon } from '@/components/icons'
import { fmtTime } from '@/lib/format'
import { useAuthStore } from '@/stores/auth-store'
import { useClockStore } from '@/stores/clock-store'
import type { Role } from '@/types'

const NAV: Array<{ to: string; label: string; Icon: typeof AlertIcon; roles: Role[] }> = [
  { to: '/cars', label: 'Cars', Icon: CarIcon, roles: ['shipper', 'ops', 'admin'] },
  { to: '/exceptions', label: 'Exceptions', Icon: AlertIcon, roles: ['ops', 'admin'] },
  { to: '/replans', label: 'Replanning', Icon: RouteIcon, roles: ['ops', 'admin'] },
  { to: '/notifications', label: 'Notifications', Icon: BellIcon, roles: ['shipper', 'ops', 'admin'] },
  { to: '/streams', label: 'Streams & DLQ', Icon: StreamIcon, roles: ['ops', 'admin'] },
]

const ROLE_LABEL: Record<Role, string> = { shipper: 'Shipper', ops: 'Network operations', admin: 'Platform admin' }

export function AppShell({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const now = useClockStore((s) => s.now)
  const simulated = useClockStore((s) => s.simulated)
  const speed = useClockStore((s) => s.speed)
  const link = 'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:text-white'
  return (
    <div className="flex h-screen overflow-hidden">
      <nav className="flex w-56 shrink-0 flex-col bg-slate-900 px-3 py-4" aria-label="Main">
        <div className="mb-6 px-2">
          <div className="text-sm font-semibold text-white">Railcar Trip Plans</div>
          <div className="text-xs text-slate-400">Plains & Northern Ry. (sim)</div>
        </div>
        <div className="space-y-1">
          {NAV.filter((n) => user && n.roles.includes(user.role)).map(({ to, label, Icon }) => (
            <Link key={to} to={to} className={link} activeProps={{ className: `${link} !bg-slate-800 !text-white` }}>
              <Icon className="h-4 w-4" /> {user?.role === 'shipper' && to === '/cars' ? 'My cars' : label}
            </Link>
          ))}
        </div>
        <div className="flex-1" />
        <div className="space-y-2 border-t border-slate-800 px-2 pt-3 text-xs text-slate-400">
          <div title="Network clock (UTC). While the simulator runs it is compressed time.">
            <div className="font-mono text-slate-200">{fmtTime(now)} UTC</div>
            {simulated && speed > 1 && <div>simulated at {speed}×</div>}
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium text-slate-200">{user?.displayName}</div>
              <div>{user && (user.role === 'shipper' ? user.shipperName : ROLE_LABEL[user.role])}</div>
            </div>
            <button type="button" onClick={() => void logout()} className="rounded p-1.5 hover:bg-slate-800 hover:text-white" title="Sign out">
              <LogoutIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
      </nav>
      <main className="relative min-w-0 flex-1 overflow-hidden bg-slate-50">{children}</main>
    </div>
  )
}
