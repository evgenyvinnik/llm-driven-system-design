import { create } from 'zustand'
import { activateOrg } from '@/lib/org-scope'
import { queryClient } from '@/lib/query-client'
import { api, ApiError } from '@/services/api'
import type { OrgSummary, User } from '@/types'

type Status = 'loading' | 'authenticated' | 'unauthenticated'

interface AuthState {
  status: Status
  user: User | null
  orgs: OrgSummary[]
  /** Why the session ended, shown on the sign-in page. */
  endedReason: string | null
  init: () => Promise<void>
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  refreshOrgs: () => Promise<void>
  /**
   * The server said 401, or the event stream said the session was revoked.
   * `specific` lets a known cause replace a generic message set a moment earlier.
   */
  expire: (reason: string, specific?: boolean) => void
}

function clearClientState() {
  activateOrg(null)
  queryClient.clear()
}

export const useAuth = create<AuthState>((set, get) => ({
  status: 'loading',
  user: null,
  orgs: [],
  endedReason: null,

  init: async () => {
    try {
      const { user, orgs } = await api.me()
      set({ status: 'authenticated', user, orgs })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) set({ status: 'unauthenticated', user: null, orgs: [] })
      else set({ status: 'unauthenticated', user: null, orgs: [], endedReason: 'Could not reach the server.' })
    }
  },

  login: async (email, password) => {
    const { user, orgs } = await api.login(email, password)
    clearClientState()
    set({ status: 'authenticated', user, orgs, endedReason: null })
  },

  logout: async () => {
    await api.logout().catch(() => undefined)
    clearClientState()
    set({ status: 'unauthenticated', user: null, orgs: [], endedReason: null })
  },

  refreshOrgs: async () => {
    if (get().status !== 'authenticated') return
    const { orgs } = await api.me()
    set({ orgs })
  },

  expire: (reason, specific = false) => {
    if (get().status === 'unauthenticated' && specific) {
      set({ endedReason: reason })
      return
    }
    if (get().status !== 'authenticated') return
    // Cached data stays until the next sign-in decides whose it is; nothing renders it meanwhile.
    set({ status: 'unauthenticated', endedReason: reason })
  },
}))

export function lastOrgKey(userId: string) {
  return `mod:lastOrg:${userId}`
}
