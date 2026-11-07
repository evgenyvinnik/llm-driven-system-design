import { Link } from '@tanstack/react-router'
import { useEffect, type ReactNode } from 'react'
import { AlertIcon, GaugeIcon, LogoutIcon, SignalIcon, StreamIcon, TrainIcon, WrenchIcon } from '@/components/icons'
import { connectLive } from '@/services/live'
import { useAuthStore } from '@/stores/auth-store'
import { useClockStore } from '@/stores/clock-store'
import { useLiveStore } from '@/stores/live-store'
import type { Role } from '@/types'

const NAV: Array<{ to: string; label: string; Icon: typeof AlertIcon; roles: Role[] }> = [
  { to: '/alerts', label: 'Alerts', Icon: AlertIcon, roles: ['dispatcher', 'admin'] },
  { to: '/trains', label: 'Trains', Icon: TrainIcon, roles: ['dispatcher', 'admin', 'yard'] },
  { to: '/yard', label: 'Yard', Icon: WrenchIcon, roles: ['yard', 'admin'] },
  { to: '/detectors', label: 'Detectors', Icon: SignalIcon, roles: ['dispatcher', 'admin', 'yard'] },
  { to: '/admin', label: 'Reliability', Icon: GaugeIcon, roles: ['admin'] },
  { to: '/ops', label: 'Ops / Streams', Icon: StreamIcon, roles: ['admin'] },
]

const ROLE_LABEL: Record<Role, string> = { dispatcher: 'Dispatcher', yard: 'Car inspector', admin: 'Reliability engineer' }

export function AppShell({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const connected = useLiveStore((s) => s.connected)
  const simulated = useClockStore((s) => s.simulated)
  const speed = useClockStore((s) => s.speed)
  useEffect(() => connectLive(), [])
  const link = 'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:text-white'
  return (
    <div className="flex h-screen overflow-hidden">
      <nav className="flex w-56 shrink-0 flex-col bg-slate-900 px-3 py-4" aria-label="Main">
        <div className="mb-6 px-2">
          <div className="text-sm font-semibold text-white">Railcar Health</div>
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
            {simulated && <span className="ml-auto rounded bg-slate-800 px-1.5 py-0.5">sim {speed}×</span>}
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium text-slate-200">{user?.displayName}</div>
              <div>{user && ROLE_LABEL[user.role]}{user?.yardId ? ` · ${user.yardId}` : ''}{user?.deskId ? ` · ${user.deskId} desk` : ''}</div>
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
