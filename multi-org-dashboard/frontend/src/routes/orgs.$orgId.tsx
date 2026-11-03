import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Outlet } from '@tanstack/react-router'
import { OrgUnavailable } from '@/components/access'
import { PreviewBanner, Sidebar, TopBar } from '@/components/layout'
import { ErrorNote, Loading } from '@/components/shared'
import { OrgContext } from '@/hooks/useOrg'
import { useManifestWatcher } from '@/hooks/useManifestWatcher'
import { brandStyle } from '@/lib/branding'
import { keys } from '@/lib/keys'
import { switchOrg } from '@/lib/org-switch'
import { api, ApiError } from '@/services/api'
import { useAccess } from '@/stores/access-store'
import { lastOrgKey, useAuth } from '@/stores/auth-store'

export const Route = createFileRoute('/orgs/$orgId')({
  // Before any page of the new org mounts: abort the old org's requests.
  beforeLoad: ({ params }) => switchOrg(params.orgId),
  component: OrgLayout,
})

function OrgLayout() {
  const { orgId } = Route.useParams()
  const userId = useAuth((s) => s.user?.id)
  const revoked = useAccess((s) => Boolean(s.revoked[orgId]))
  const query = useQuery({
    queryKey: keys.manifest(orgId),
    queryFn: ({ signal }) => api.manifest(orgId, signal),
    enabled: !revoked,
    staleTime: 60_000,
  })
  const manifest = query.data?.manifest
  useManifestWatcher(orgId, manifest)

  useEffect(() => {
    if (!userId || !manifest) return
    try {
      localStorage.setItem(lastOrgKey(userId), orgId)
    } catch {
      // storage unavailable: the org picker just opens the first org next time
    }
  }, [userId, orgId, manifest])

  if (revoked) return <OrgUnavailable orgId={orgId} />
  if (query.error instanceof ApiError && query.error.status === 404) return <OrgUnavailable orgId={orgId} />
  if (query.error && !manifest) {
    return (
      <div className="p-8">
        <ErrorNote error={query.error} />
      </div>
    )
  }
  if (!manifest) return <Loading label="Loading organization…" />

  return (
    // Keyed by org: no component state (open forms, selections) survives a switch.
    <OrgContext.Provider key={orgId} value={{ orgId, manifest }}>
      <div style={brandStyle(manifest.org.branding.accent)} className="flex h-screen flex-col" data-org={orgId}>
        <PreviewBanner />
        <TopBar />
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <main className="min-w-0 flex-1 overflow-auto p-6">
            <Outlet />
          </main>
        </div>
      </div>
    </OrgContext.Provider>
  )
}
