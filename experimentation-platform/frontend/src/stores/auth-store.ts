import { create } from 'zustand'
import { api } from '@/services/api'
import type { User } from '@/types'

interface AuthState {
  user: User | null
  checked: boolean
  check: () => Promise<void>
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  checked: false,
  async check() {
    const before = get().user
    try {
      const { user } = await api.me()
      set({ user, checked: true })
    } catch {
      // Don't clobber a login that completed while this probe was in flight.
      if (get().user === before) set({ user: null })
      set({ checked: true })
    }
  },
  async login(username, password) {
    const { user } = await api.login(username, password)
    set({ user, checked: true })
  },
  async logout() {
    await api.logout().catch(() => undefined)
    set({ user: null })
  },
}))

/** Viewers see every control disabled; the server rejects their writes regardless. */
export const useCanEdit = () => useAuthStore((s) => s.user?.role === 'admin')
