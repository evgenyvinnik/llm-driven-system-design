import { Link } from '@tanstack/react-router'
import { useEffect, type ReactNode } from 'react'
import { BellIcon, GaugeIcon, InboxIcon, ListIcon, LogoutIcon, PlugIcon, WebhookIcon } from '@/components/icons'
import { useAuthStore } from '@/stores/auth-store'
import { useNotificationStore } from '@/stores/notification-store'

const CUSTOMER_NAV = [
  { to: '/endpoints', label: 'Endpoints', Icon: PlugIcon },
  { to: '/events', label: 'Event log', Icon: ListIcon },
  { to: '/receiver', label: 'Mock receiver', Icon: InboxIcon },
  { to: '/notifications', label: 'Notifications', Icon: BellIcon },
] as const

const OPERATOR_NAV = [{ to: '/ops', label: 'Operations', Icon: GaugeIcon }] as const

export function AppShell({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const unread = useNotificationStore((s) => s.unread)
  const isCustomer = user?.role === 'customer'

  useEffect(() => {
    if (!isCustomer) return
    const refresh = () => void useNotificationStore.getState().refresh()
    refresh()
    const id = window.setInterval(refresh, 5000)
    return () => window.clearInterval(id)
  }, [isCustomer])

  const nav = isCustomer ? CUSTOMER_NAV : OPERATOR_NAV
  const link = 'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:text-white'
  return (
    <div className="flex h-screen overflow-hidden">
      <nav className="flex w-56 shrink-0 flex-col bg-slate-900 px-3 py-4" aria-label="Main">
        <div className="mb-6 flex items-center gap-2 px-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-600 text-white">
            <WebhookIcon className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-semibold text-white">Webhooks</div>
            <div className="text-[11px] text-slate-400">{user?.orgName ?? 'Platform operations'}</div>
          </div>
        </div>
        <div className="space-y-1">
          {nav.map(({ to, label, Icon }) => (
            <Link key={to} to={to} className={link} activeProps={{ className: `${link} !bg-slate-800 !text-white` }}>
              <Icon className="h-4 w-4" /> <span className="flex-1">{label}</span>
              {to === '/notifications' && unread > 0 && (
                <span className="num rounded-full bg-red-500 px-1.5 text-[11px] font-semibold text-white" aria-label={`${unread} unread`}>
                  {unread}
                </span>
              )}
            </Link>
          ))}
        </div>
        <div className="flex-1" />
        <div className="flex items-center justify-between rounded-md px-3 py-2 text-sm text-slate-300">
          <div>
            <div className="font-medium text-white">{user?.displayName}</div>
            <div className="text-xs text-slate-400">{isCustomer ? `${user?.username} · customer` : 'operator'}</div>
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
