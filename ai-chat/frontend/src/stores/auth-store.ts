/**
 * Who is signed in. When the server can't be reached at startup but this
 * browser has a cached copy for the last user, the app opens in offline,
 * read-only mode for that user instead of showing the sign-in form.
 */
import { create } from 'zustand'
import { api, ApiError, isNetworkError } from '@/services/api'
import * as cache from '@/services/offline-cache'
import { useConversations } from '@/stores/conversations-store'
import { useGenerations } from '@/stores/generations-store'
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
      cache.setCacheUser(user)
      set({ user, status: 'authenticated' })
    } catch (err) {
      const cached = isNetworkError(err) ? cache.lastCachedUser() : null
      if (cached) {
        cache.setCacheUser(cached)
        set({ user: cached, status: 'authenticated' })
        return
      }
      if (err instanceof ApiError && err.status !== 401 && !isNetworkError(err)) console.warn('session check failed', err)
      set({ user: null, status: 'anonymous' })
    }
  },
  login: async (username, password) => {
    const { user } = await api.login(username, password)
    cache.setCacheUser(user)
    set({ user, status: 'authenticated' })
  },
  logout: async () => {
    await api.logout().catch(() => undefined)
    useGenerations.getState().reset()
    useConversations.getState().reset()
    await cache.clearCache()
    set({ user: null, status: 'anonymous' })
  },
}))
