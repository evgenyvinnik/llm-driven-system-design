/**
 * Users are shared by both pages: the Files page offers them as owners, and the
 * Users page manages them. Reloaded after any write that changes usage.
 */
import { create } from 'zustand'
import { api, errorMessage } from '@/services/api'
import type { UserSummary } from '@/types'

interface UsersState {
  users: UserSummary[]
  loaded: boolean
  error: string | null
  load: () => Promise<void>
}

export const useUsers = create<UsersState>((set) => ({
  users: [],
  loaded: false,
  error: null,
  load: async () => {
    try {
      const { users } = await api.users()
      set({ users, loaded: true, error: null })
    } catch (err) {
      set({ loaded: true, error: errorMessage(err) })
    }
  },
}))
