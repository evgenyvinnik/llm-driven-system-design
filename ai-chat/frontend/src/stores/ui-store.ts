/**
 * Small app-wide UI signals: the screen-reader announcement and toasts.
 *
 * Streaming text is deliberately NOT a live region: announcing every token
 * would bury the user in partial sentences. Instead one polite announcement
 * is made when an answer starts and one when it ends.
 */
import { create } from 'zustand'

export interface Toast {
  id: number
  message: string
  tone: 'info' | 'success' | 'error'
  conversationId?: string
}

interface UiState {
  announcement: { text: string; nonce: number }
  toasts: Toast[]
  announce: (text: string) => void
  toast: (toast: Omit<Toast, 'id'>, durationMs?: number) => void
  dismiss: (id: number) => void
}

let nextId = 1

export const useUi = create<UiState>((set, get) => ({
  announcement: { text: '', nonce: 0 },
  toasts: [],
  // The nonce makes the same text announce again (e.g. two answers completing in a row).
  announce: (text) => set({ announcement: { text, nonce: get().announcement.nonce + 1 } }),
  toast: (toast, durationMs = 8000) => {
    const id = nextId++
    set({ toasts: [...get().toasts, { ...toast, id }].slice(-4) })
    setTimeout(() => get().dismiss(id), durationMs)
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}))
