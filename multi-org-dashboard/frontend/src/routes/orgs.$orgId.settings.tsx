import { createFileRoute, Link, Outlet } from '@tanstack/react-router'
import { ModuleGate } from '@/components/access'
import { PageHeader } from '@/components/shared'
import { useOrg } from '@/hooks/useOrg'
import { decide, SETTINGS_TABS } from '@/lib/modules'

export const Route = createFileRoute('/orgs/$orgId/settings')({
  component: () => (
    <ModuleGate module="settings">
      <SettingsLayout />
    </ModuleGate>
  ),
})

const TAB_ROUTES = {
  members: '/orgs/$orgId/settings/members',
  invitations: '/orgs/$orgId/settings/invitations',
  links: '/orgs/$orgId/settings/links',
  audit: '/orgs/$orgId/settings/audit',
  features: '/orgs/$orgId/settings/features',
} as const

function SettingsLayout() {
  const { orgId, manifest } = useOrg()
  const tabs = SETTINGS_TABS.filter((t) => decide(manifest, t.requires).allowed)
  return (
    <div className="max-w-5xl">
      <PageHeader title="Settings" description={`Members, invitations, links and audit history for ${manifest.org.name}.`} />
      <nav className="mb-4 flex gap-1 border-b border-slate-200" aria-label="Settings sections">
        {tabs.map((t) => (
          <Link
            key={t.key}
            to={TAB_ROUTES[t.key]}
            params={{ orgId }}
            className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-slate-600 hover:text-slate-900"
            activeProps={{ className: '!border-brand-600 font-medium !text-brand-700' }}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </div>
  )
}
