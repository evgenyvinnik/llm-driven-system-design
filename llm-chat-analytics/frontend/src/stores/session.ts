/**
 * Signed-in user and the orgs they can open. Roles come from the server on
 * every /me call; the client uses them only to decide what to render, never as
 * the security boundary (the API leaves out what a role can't see).
 */
import { create } from 'zustand'
import { api, ApiError, type OrgAccess, type User } from '../lib/api'

interface SessionState {
  user: User | null
  orgs: OrgAccess[]
  status: 'unknown' | 'signed-in' | 'signed-out'
  load: () => Promise<void>
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

export const useSession = create<SessionState>((set) => ({
  user: null,
  orgs: [],
  status: 'unknown',
  load: async () => {
    try {
      const me = await api<{ user: User; orgs: OrgAccess[] }>('/auth/me')
      set({ user: me.user, orgs: me.orgs, status: 'signed-in' })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) set({ user: null, orgs: [], status: 'signed-out' })
      else throw err
    }
  },
  login: async (username, password) => {
    const me = await api<{ user: User; orgs: OrgAccess[] }>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) })
    set({ user: me.user, orgs: me.orgs, status: 'signed-in' })
  },
  logout: async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined)
    set({ user: null, orgs: [], status: 'signed-out' })
  },
}))
