import { create } from 'zustand'
import { newId } from '@/lib/format'

export interface Toast {
  id: string
  message: string
  tone: 'info' | 'success' | 'error'
  /** Milliseconds before auto-dismiss. */
  durationMs?: number
  /** Optional link to a prompt's playground. */
  promptId?: string
  runId?: string
}

interface ToastState {
  toasts: Toast[]
  push: (toast: Omit<Toast, 'id'>) => void
  dismiss: (id: string) => void
}

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (toast) => {
    const id = newId()
    set({ toasts: [...get().toasts.slice(-3), { ...toast, id }] })
    setTimeout(() => get().dismiss(id), toast.durationMs ?? 6000)
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}))
