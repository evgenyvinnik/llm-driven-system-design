import { createFileRoute } from '@tanstack/react-router'
import { useMemo } from 'react'
import { CategorySection } from '@/components/settings/CategorySection'
import { WarningsBanner } from '@/components/settings/WarningsBanner'
import { Loading } from '@/components/shared/Loading'
import { categoryTitle, groupByCategory } from '@/lib/display'
import { appSettings, useAppSettings } from '@/stores/app-settings'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/settings')({ component: SettingsPage })

/** The "given" preferences screen: every control is driven by the definitions and the effective document. */
function SettingsPage() {
  const user = useAuthStore((s) => s.user)
  const status = useAppSettings((s) => s.status)
  const error = useAppSettings((s) => s.error)
  const definitions = useAppSettings((s) => s.definitions)
  const settings = useAppSettings((s) => s.doc?.settings)
  const groups = useMemo(() => groupByCategory(definitions), [definitions])

  const counts = useMemo(() => {
    const c = { user: 0, enforced: 0, org: 0, default: 0 }
    for (const e of Object.values(settings ?? {})) c[e.source] += 1
    return c
  }, [settings])

  return (
    <main className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink">Preferences</h1>
          <p className="mt-1 text-sm text-muted">
            Changes save as you make them, sync to your other tabs and devices, and follow {user?.orgName}&apos;s policy.
          </p>
        </div>
        {status === 'ready' && (
          <p className="text-xs text-muted" data-testid="source-summary">
            {counts.user} your choices · {counts.org} from {user?.orgName} · {counts.enforced} enforced · {counts.default} defaults
          </p>
        )}
      </div>
      {status === 'error' && <p className="card p-4 text-sm text-red-700">Could not load settings: {error}</p>}
      {status !== 'ready' && status !== 'error' && <Loading label="Loading your settings…" />}
      {status === 'ready' && (
        <div className="grid gap-6 lg:grid-cols-[180px_minmax(0,1fr)]">
          <nav className="hidden lg:block" aria-label="Sections">
            <ul className="sticky top-20 space-y-1 text-sm">
              {groups.map(([cat]) => (
                <li key={cat}>
                  <a href={`#cat-${cat}`} className="block rounded-lg px-3 py-1.5 text-muted hover:bg-sunken hover:text-ink">
                    {categoryTitle(cat)}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="space-y-5" data-ready="true">
            <WarningsBanner store={appSettings} />
            {groups.map(([cat, defs]) => (
              <CategorySection key={cat} store={appSettings} category={cat} defs={defs} orgName={user?.orgName ?? 'your organization'} />
            ))}
          </div>
        </div>
      )}
    </main>
  )
}
