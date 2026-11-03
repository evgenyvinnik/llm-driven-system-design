import { useEffect, useRef } from 'react'
import { keys } from '@/lib/keys'
import { lostModules, MODULES, decide } from '@/lib/modules'
import { queryClient } from '@/lib/query-client'
import { useAccess } from '@/stores/access-store'
import type { Manifest } from '@/types'

/**
 * Compares each new manifest version with the previous one and records the
 * modules the user just lost, so their open pages can explain themselves.
 * A preview (same version, different role) is not a loss.
 */
export function useManifestWatcher(orgId: string, manifest: Manifest | undefined): void {
  const previous = useRef<Manifest | null>(null)
  const recordLost = useAccess((s) => s.recordLost)

  useEffect(() => {
    if (!manifest) return
    const before = previous.current
    previous.current = manifest
    if (!before || before.org.id !== manifest.org.id || manifest.version <= before.version) return
    // Data loaded under the old access may now be too much (rows from a project no longer visible,
    // fields the new role doesn't get). Refetch it all; pages the user lost are closed by the guards.
    void queryClient.invalidateQueries({
      predicate: (q) => q.queryKey[0] === keys.org(orgId)[0] && q.queryKey[1] === orgId && q.queryKey[2] !== 'manifest',
    })
    const lost = lostModules(before, manifest)
    if (lost.length > 0) recordLost(orgId, lost)
    // Regained modules stop counting as lost.
    const regained = MODULES.filter((m) => decide(manifest, m.requires).allowed).map((m) => m.key)
    const state = useAccess.getState()
    const stillLost = (state.lost[orgId] ?? []).filter((k) => !regained.includes(k))
    if (stillLost.length !== (state.lost[orgId] ?? []).length) useAccess.setState({ lost: { ...state.lost, [orgId]: stillLost } })
  }, [orgId, manifest, recordLost])
}
