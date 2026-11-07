import { create } from 'zustand'
import { api } from '@/services/api'
import type { User } from '@/types'
import { useAskStore } from './ask-store'

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
    useAskStore.getState().reset()
    set({ user, checked: true })
  },
  async logout() {
    await api.logout().catch(() => undefined)
    useAskStore.getState().reset()
    set({ user: null })
  },
}))
