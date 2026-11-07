import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { LogoutIcon } from '@/components/icons'
import { SyncPill } from '@/components/settings/SyncPill'
import { appSettings } from '@/stores/app-settings'
import { isAdmin, useAuthStore } from '@/stores/auth-store'

const ROLE_LABEL = { member: 'Member', org_admin: 'Org admin', platform_admin: 'Platform admin' } as const

export function AppShell({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const links: Array<{ to: '/settings' | '/devices' | '/admin' | '/catalog'; label: string }> = [
    { to: '/settings', label: 'Preferences' },
    { to: '/devices', label: 'Two devices' },
  ]
  if (isAdmin(user)) links.push({ to: '/admin', label: 'Org policy' }, { to: '/catalog', label: 'Catalog' })

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <div className="flex items-center gap-2">
            <img src="/favicon.svg" alt="" className="h-7 w-7" />
            <div className="leading-tight">
              <div className="text-sm font-semibold text-ink">Settings</div>
              <div className="text-[11px] text-muted">{user?.orgName}</div>
            </div>
          </div>
          <nav className="flex flex-wrap gap-1" aria-label="Main">
            {links.map((l) => (
              <Link
                key={l.to}
                to={l.to}
                className="rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-sunken hover:text-ink"
                activeProps={{ className: 'rounded-lg px-3 py-1.5 text-sm bg-accent-50 font-medium text-accent-700 dark:bg-accent-500/15 dark:text-accent-100' }}
              >
                {l.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <SyncPill store={appSettings} />
            <div className="text-right leading-tight">
              <div className="text-sm font-medium text-ink">{user?.displayName}</div>
              <div className="text-[11px] text-muted">{user ? ROLE_LABEL[user.role] : ''}</div>
            </div>
            <button type="button" onClick={() => void logout()} className="rounded-lg p-2 text-muted hover:bg-sunken hover:text-ink" aria-label="Sign out" title="Sign out">
              <LogoutIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>
      {children}
    </div>
  )
}
