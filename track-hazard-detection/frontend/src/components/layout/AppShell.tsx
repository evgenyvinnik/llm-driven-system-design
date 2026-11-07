import { Link } from '@tanstack/react-router'
import { useEffect, type ReactNode } from 'react'
import { BellIcon, GaugeIcon, LayersIcon, ListIcon, LogoutIcon, MapIcon, SignIcon } from '@/components/icons'
import { connectLive } from '@/services/live'
import { CriticalBanner } from './CriticalBanner'
import { useAuthStore } from '@/stores/auth-store'
import { useLiveStore } from '@/stores/live-store'
import type { Role } from '@/types'

const NAV: Array<{ to: string; label: string; Icon: typeof MapIcon; roles: Role[] }> = [
  { to: '/board', label: 'Operator board', Icon: MapIcon, roles: ['dispatcher', 'admin', 'inspector'] },
  { to: '/alerts', label: 'Alert queue', Icon: BellIcon, roles: ['dispatcher', 'admin', 'inspector'] },
  { to: '/restrictions', label: 'Speed restrictions', Icon: SignIcon, roles: ['dispatcher', 'admin', 'inspector'] },
  { to: '/latency', label: 'Latency budget', Icon: GaugeIcon, roles: ['dispatcher', 'admin'] },
  { to: '/events', label: 'Event log', Icon: ListIcon, roles: ['dispatcher', 'admin'] },
  { to: '/ops', label: 'Streams & DLQ', Icon: LayersIcon, roles: ['admin', 'dispatcher'] },
]

const ROLE_LABEL: Record<Role, string> = { dispatcher: 'Dispatcher', inspector: 'Track inspector', admin: 'Platform operator' }

export function AppShell({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const connected = useLiveStore((s) => s.connected)
  useEffect(() => connectLive(), [])
  const link = 'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:text-white'
  return (
    <div className="flex h-screen overflow-hidden">
      <nav className="flex w-56 shrink-0 flex-col bg-slate-900 px-3 py-4" aria-label="Main">
        <div className="mb-6 px-2">
          <div className="text-sm font-semibold text-white">Track Hazard Detection</div>
          <div className="text-xs text-slate-400">Plains & Northern Ry. (sim)</div>
        </div>
        <div className="space-y-1">
          {NAV.filter((n) => user && n.roles.includes(user.role)).map(({ to, label, Icon }) => (
            <Link key={to} to={to} className={link} activeProps={{ className: `${link} !bg-slate-800 !text-white` }}>
              <Icon className="h-4 w-4" /> {label}
            </Link>
          ))}
        </div>
        <div className="flex-1" />
        <div className="space-y-2 border-t border-slate-800 px-2 pt-3 text-xs text-slate-400">
          <div className="flex items-center gap-2" title={connected ? 'Live updates connected (SSE)' : 'Reconnecting; screens refresh when back'}>
            <span className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-slate-500'}`} />
            {connected ? 'Live' : 'Reconnecting…'}
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium text-slate-200">{user?.displayName}</div>
              <div>
                {user && ROLE_LABEL[user.role]}
                {user?.deskId ? ` · ${user.deskId} desk` : ''}
              </div>
            </div>
            <button type="button" onClick={() => void logout()} className="rounded p-1.5 hover:bg-slate-800 hover:text-white" title="Sign out">
              <LogoutIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
      </nav>
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-slate-50">
        <CriticalBanner />
        <div className="min-h-0 flex-1">{children}</div>
      </main>
    </div>
  )
}
