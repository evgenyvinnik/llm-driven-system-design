/**
 * What changed about the user's access during this session, per org, so a
 * view that closes can say why instead of going blank.
 */
import { create } from 'zustand'
import type { ModuleKey } from '@/lib/modules'
import type { Role } from '@/types'

export interface AccessChange {
  reason: 'role_changed' | 'flag_changed' | 'member_removed' | 'member_added' | 'project_access_changed' | 'unknown'
  from?: Role
  to?: Role
  at: number
}

interface AccessState {
  revoked: Record<string, { orgName: string; at: number }>
  lastChange: Record<string, AccessChange>
  lost: Record<string, ModuleKey[]>
  markRevoked: (orgId: string, orgName: string) => void
  recordChange: (orgId: string, change: Omit<AccessChange, 'at'>) => void
  recordLost: (orgId: string, modules: ModuleKey[]) => void
  forget: (orgId: string) => void
}

export const useAccess = create<AccessState>((set) => ({
  revoked: {},
  lastChange: {},
  lost: {},
  markRevoked: (orgId, orgName) => set((s) => ({ revoked: { ...s.revoked, [orgId]: { orgName, at: Date.now() } } })),
  recordChange: (orgId, change) =>
    set((s) => ({ lastChange: { ...s.lastChange, [orgId]: { ...change, at: Date.now() } } })),
  recordLost: (orgId, modules) =>
    set((s) => ({ lost: { ...s.lost, [orgId]: [...new Set([...(s.lost[orgId] ?? []), ...modules])] } })),
  forget: (orgId) =>
    set((s) => ({
      revoked: Object.fromEntries(Object.entries(s.revoked).filter(([id]) => id !== orgId)),
      lost: Object.fromEntries(Object.entries(s.lost).filter(([id]) => id !== orgId)),
    })),
}))
