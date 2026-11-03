import { useEffect, useRef } from 'react'
import { lostModules, MODULES, decide } from '@/lib/modules'
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
    const lost = lostModules(before, manifest)
    if (lost.length > 0) recordLost(orgId, lost)
    // Regained modules stop counting as lost.
    const regained = MODULES.filter((m) => decide(manifest, m.requires).allowed).map((m) => m.key)
    const state = useAccess.getState()
    const stillLost = (state.lost[orgId] ?? []).filter((k) => !regained.includes(k))
    if (stillLost.length !== (state.lost[orgId] ?? []).length) useAccess.setState({ lost: { ...state.lost, [orgId]: stillLost } })
  }, [orgId, manifest, recordLost])
}
