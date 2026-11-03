import { useNavigate } from '@tanstack/react-router'
import { LogoutIcon } from '@/components/icons'
import { RoleBadge } from '@/components/shared'
import { useOrg } from '@/hooks/useOrg'
import { useAuth } from '@/stores/auth-store'
import { ExportsIndicator } from './ExportsIndicator'
import { OrgSwitcher } from './OrgSwitcher'
import { ViewAsMenu } from './ViewAs'

export function TopBar() {
  const { manifest } = useOrg()
  const user = useAuth((s) => s.user)
  const logout = useAuth((s) => s.logout)
  const navigate = useNavigate()
  return (
    <header className="flex h-14 items-center gap-3 border-b border-slate-200 bg-white px-4">
      <span className="mr-2 text-sm font-semibold tracking-tight text-slate-900">Relay</span>
      <OrgSwitcher />
      <RoleBadge role={manifest.role} />
      <div className="ml-auto flex items-center gap-4">
        <ExportsIndicator />
        <ViewAsMenu />
        <span className="text-sm text-slate-600">{user?.displayName}</span>
        <button
          className="btn-ghost px-2"
          onClick={async () => {
            await logout()
            void navigate({ to: '/login' })
          }}
          title="Sign out"
        >
          <LogoutIcon />
        </button>
      </div>
    </header>
  )
}
