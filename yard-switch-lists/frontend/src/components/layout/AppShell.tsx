import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { ChartIcon, ListIcon, LogoutIcon, PhoneIcon, PlayIcon, ScaleIcon, ShieldIcon, YardIcon } from '@/components/icons'
import { useAuthStore } from '@/stores/auth-store'

const NAV = [
  { to: '/board', label: 'Board', Icon: YardIcon, roles: ['yardmaster', 'admin'] },
  { to: '/crew', label: 'Handheld', Icon: PhoneIcon, roles: ['yardmaster', 'admin', 'crew'] },
  { to: '/plans', label: 'Plans', Icon: ListIcon, roles: ['yardmaster', 'admin'] },
  { to: '/holds', label: 'Holds', Icon: ShieldIcon, roles: ['yardmaster', 'admin'] },
  { to: '/compare', label: 'Compare', Icon: ScaleIcon, roles: ['yardmaster', 'admin'] },
  { to: '/metrics', label: 'Metrics', Icon: ChartIcon, roles: ['yardmaster', 'admin'] },
  { to: '/simulator', label: 'Simulator', Icon: PlayIcon, roles: ['yardmaster', 'admin'] },
] as const

export function AppShell({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const link = 'flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:text-white'
  return (
    <div className="min-h-screen">
      <nav className="sticky top-0 z-30 flex items-center gap-1 overflow-x-auto bg-slate-900 px-3 py-2" aria-label="Main">
        <div className="mr-3 flex items-center gap-2 text-white">
          <YardIcon className="h-5 w-5 text-sky-300" />
          <span className="whitespace-nowrap text-sm font-semibold">Yard Board</span>
        </div>
        {NAV.filter((n) => user && (n.roles as readonly string[]).includes(user.role)).map(({ to, label, Icon }) => (
          <Link key={to} to={to} className={link} activeProps={{ className: `${link} !bg-slate-800 !text-white` }}>
            <Icon className="h-4 w-4" /> <span className="hidden sm:inline">{label}</span>
          </Link>
        ))}
        <div className="flex-1" />
        <span className="hidden whitespace-nowrap text-xs text-slate-400 md:inline">
          {user?.displayName} · {user?.role}
        </span>
        <button type="button" className="ml-2 rounded p-1.5 text-slate-300 hover:bg-slate-800" onClick={() => void logout()} title="Sign out" aria-label="Sign out">
          <LogoutIcon className="h-4 w-4" />
        </button>
      </nav>
      {children}
    </div>
  )
}
