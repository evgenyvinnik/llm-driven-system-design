/**
 * Unread notification count for the nav badge, refreshed by the shell's poll.
 */
import { create } from 'zustand'
import { api } from '@/services/api'

interface NotificationState {
  unread: number
  refresh: () => Promise<void>
}

export const useNotificationStore = create<NotificationState>((set) => ({
  unread: 0,
  async refresh() {
    try {
      const { unread } = await api.notifications()
      set({ unread })
    } catch {
      // Signed out or offline: keep the last count.
    }
  },
}))
