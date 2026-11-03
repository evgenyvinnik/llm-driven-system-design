import { createContext, useContext } from 'react'
import { can, decide, type Requirement } from '@/lib/modules'
import type { Manifest, Permission } from '@/types'

export interface OrgContextValue {
  orgId: string
  manifest: Manifest
}

export const OrgContext = createContext<OrgContextValue | null>(null)

/** The current org and its manifest. Only valid under the org layout. */
export function useOrg(): OrgContextValue {
  const value = useContext(OrgContext)
  if (!value) throw new Error('useOrg must be used inside the org layout')
  return value
}

/** For action buttons: true when the role has the permission and this isn't a read-only preview. */
export function useCan(permission: Permission, opts: { write?: boolean } = { write: true }): boolean {
  const { manifest } = useOrg()
  if (opts.write && manifest.readOnly) return false
  return can(manifest, permission)
}

export function useDecision(req: Requirement) {
  return decide(useOrg().manifest, req)
}
