import { activateOrg, getActiveOrgId } from './org-scope'
import { keys } from './keys'
import { queryClient } from './query-client'

/**
 * Runs in the org route's beforeLoad, before any child component mounts.
 * Cancelling through TanStack Query first lets it restore the old entries'
 * previous state; then the scope controller aborts everything else (mutations,
 * one-off fetches) that was bound to the old org.
 */
export function switchOrg(orgId: string): void {
  const previous = getActiveOrgId()
  if (previous === orgId) return
  if (previous) void queryClient.cancelQueries({ queryKey: keys.org(previous) })
  activateOrg(orgId)
}
