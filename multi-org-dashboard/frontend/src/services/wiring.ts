/**
 * Connects the API client's hooks to the stores. Kept out of the client so
 * the client has no idea how the app routes or caches.
 */
import { keys } from '@/lib/keys'
import { queryClient } from '@/lib/query-client'
import { useAuth } from '@/stores/auth-store'
import type { Manifest } from '@/types'
import { apiHooks } from './api'

export function cachedManifestVersion(orgId: string): number | null {
  return queryClient.getQueryData<{ manifest: Manifest }>(keys.manifest(orgId))?.manifest.version ?? null
}

/** Refetch an org's manifest if what we hold is older than `version` (or if we hold nothing and it's in use). */
export function refreshManifestIfBehind(orgId: string, version?: number): void {
  const cached = cachedManifestVersion(orgId)
  if (cached === null) return
  // cancelRefetch: false joins a refresh already in flight instead of restarting it.
  if (version === undefined || cached < version) {
    void queryClient.invalidateQueries({ queryKey: keys.manifest(orgId) }, { cancelRefetch: false })
  }
}

export function wireApi(): void {
  apiHooks.onUnauthenticated = () => useAuth.getState().expire('Your session has ended. Sign in again to pick up where you left off.')
  // A 403 means our idea of the role may be stale: ask again, and let the guards re-render.
  apiHooks.onForbidden = (orgId) => refreshManifestIfBehind(orgId)
  apiHooks.onAuthzVersion = (orgId, version) => refreshManifestIfBehind(orgId, version)
}
