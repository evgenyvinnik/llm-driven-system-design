import { create } from 'zustand'
import { api, ApiError } from '@/services/api'
import type { User } from '@/types'

interface AuthState {
  user: User | null
  status: 'loading' | 'authenticated' | 'anonymous'
  init: () => Promise<void>
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  status: 'loading',
  init: async () => {
    try {
      const { user } = await api.me()
      set({ user, status: 'authenticated' })
    } catch (err) {
      if (err instanceof ApiError && err.status !== 401) console.warn('session check failed', err)
      set({ user: null, status: 'anonymous' })
    }
  },
  login: async (username, password) => {
    const { user } = await api.login(username, password)
    set({ user, status: 'authenticated' })
  },
  logout: async () => {
    await api.logout().catch(() => undefined)
    set({ user: null, status: 'anonymous' })
  },
}))
