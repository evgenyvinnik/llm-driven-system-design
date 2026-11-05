import { Link } from '@tanstack/react-router'
import { useEffect, type ReactNode } from 'react'
import { AlertIcon, FuelIcon, LogoutIcon, PulseIcon, TagIcon, TrainIcon, TruckIcon } from '@/components/icons'
import { useAuthStore } from '@/stores/auth-store'
import { useLiveStore } from '@/stores/live-store'

const NAV = [
  { to: '/fleet', label: 'Fleet', Icon: TrainIcon, roles: ['fuel_desk', 'admin', 'crew'] },
  { to: '/orders', label: 'DTL orders', Icon: TruckIcon, roles: ['fuel_desk', 'admin'] },
  { to: '/anomalies', label: 'Anomalies', Icon: PulseIcon, roles: ['fuel_desk', 'admin', 'crew'] },
  { to: '/prices', label: 'Prices & model', Icon: TagIcon, roles: ['fuel_desk', 'admin'] },
] as const

const ROLE_LABEL = { fuel_desk: 'Fuel desk', crew: 'Crew', admin: 'Admin' }

export function AppShell({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const connected = useLiveStore((s) => s.connected)
  useEffect(() => {
    useLiveStore.getState().connect()
    return () => useLiveStore.getState().disconnect()
  }, [])
  const link = 'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:text-white'
  return (
    <div className="flex h-screen overflow-hidden">
      <nav className="flex w-56 shrink-0 flex-col bg-slate-900 px-3 py-4" aria-label="Main">
        <div className="mb-6 flex items-center gap-2 px-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-600 text-white">
            <FuelIcon className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-semibold text-white">Fuel Desk</div>
            <div className="text-[11px] text-slate-400">Locomotive fueling</div>
          </div>
        </div>
        <div className="space-y-1">
          {NAV.filter((n) => user && (n.roles as readonly string[]).includes(user.role)).map(({ to, label, Icon }) => (
            <Link key={to} to={to} className={link} activeProps={{ className: `${link} !bg-slate-800 !text-white` }}>
              <Icon className="h-4 w-4" /> {label}
            </Link>
          ))}
        </div>
        <div className="flex-1" />
        <div className="mb-3 flex items-center gap-2 px-3 text-xs text-slate-400" role="status">
          <span className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-amber-400'}`} aria-hidden />
          {connected ? 'Live updates on' : 'Reconnecting (polling)'}
        </div>
        {user?.role === 'crew' && (
          <div className="mx-3 mb-3 flex items-center gap-1.5 rounded-md bg-slate-800 px-2 py-1.5 text-xs text-slate-300">
            <AlertIcon className="h-3.5 w-3.5" /> Read-only crew view
          </div>
        )}
        <div className="flex items-center justify-between rounded-md px-3 py-2 text-sm text-slate-300">
          <div>
            <div className="font-medium text-white">{user?.displayName}</div>
            <div className="text-xs text-slate-400">{user ? ROLE_LABEL[user.role] : ''}</div>
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
