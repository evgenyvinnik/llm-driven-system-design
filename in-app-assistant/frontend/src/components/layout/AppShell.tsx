import { Link, useRouterState } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { AssistantPanel } from '@/components/assistant/AssistantPanel'
import { CalendarIcon, DocIcon, GaugeIcon, LogoutIcon, MailIcon, SettingsIcon, SparkleIcon } from '@/components/icons'
import { useAssistantStore } from '@/stores/assistant-store'
import { useAuthStore } from '@/stores/auth-store'
import type { App } from '@/types'

function appFor(pathname: string): App | null {
  if (pathname.startsWith('/docs')) return 'docs'
  if (pathname.startsWith('/calendar')) return 'calendar'
  if (pathname.startsWith('/mail') || pathname === '/') return 'mail'
  return null
}

const NAV = [
  { to: '/mail', label: 'Mail', Icon: MailIcon },
  { to: '/docs', label: 'Docs', Icon: DocIcon },
  { to: '/calendar', label: 'Calendar', Icon: CalendarIcon },
] as const

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const open = useAssistantStore((s) => s.open)
  const setOpen = useAssistantStore((s) => s.setOpen)
  const app = appFor(pathname)
  const railLink = 'flex flex-col items-center gap-0.5 rounded-lg px-2 py-2 text-[11px] font-medium text-slate-400 hover:bg-slate-800 hover:text-white'
  return (
    <div className="flex h-screen overflow-hidden">
      <nav className="flex w-[72px] shrink-0 flex-col items-center gap-1 bg-slate-900 py-3" aria-label="Apps">
        <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl bg-accent-600 text-white" title="Lumen Workspace">
          <SparkleIcon className="h-5 w-5" />
        </div>
        {NAV.map(({ to, label, Icon }) => (
          <Link key={to} to={to} className={railLink} activeProps={{ className: `${railLink} !bg-slate-800 !text-white` }}>
            <Icon className="h-5 w-5" />
            {label}
          </Link>
        ))}
        <div className="flex-1" />
        <Link to="/settings" className={railLink} activeProps={{ className: `${railLink} !bg-slate-800 !text-white` }}>
          <SettingsIcon className="h-5 w-5" />
          Settings
        </Link>
        {user?.role === 'admin' && (
          <Link to="/admin" className={railLink} activeProps={{ className: `${railLink} !bg-slate-800 !text-white` }}>
            <GaugeIcon className="h-5 w-5" />
            Ops
          </Link>
        )}
        <button type="button" onClick={() => void logout()} className={railLink} title={`Sign out ${user?.displayName}`}>
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-700 text-xs font-semibold text-white">{user?.displayName.charAt(0)}</span>
          <LogoutIcon className="h-3.5 w-3.5" />
        </button>
      </nav>
      <main className="relative min-w-0 flex-1 overflow-hidden bg-white">{children}</main>
      {app && open && <AssistantPanel app={app} />}
      {app && !open && (
        <button type="button" onClick={() => setOpen(true)} className="btn-primary fixed bottom-5 right-5 rounded-full px-4 py-2.5 shadow-lg">
          <SparkleIcon className="h-4 w-4" /> Ask the assistant
        </button>
      )}
    </div>
  )
}
