import { create } from 'zustand'

export interface Toast {
  id: number
  tone: 'info' | 'success' | 'warning' | 'error'
  title: string
  body?: string
  action?: { label: string; href?: string; to?: string }
}

interface ToastState {
  toasts: Toast[]
  push: (toast: Omit<Toast, 'id'>, ttlMs?: number) => void
  dismiss: (id: number) => void
}

let nextId = 1

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (toast, ttlMs = 6000) => {
    const id = nextId++
    set({ toasts: [...get().toasts.slice(-3), { ...toast, id }] })
    if (ttlMs > 0) setTimeout(() => get().dismiss(id), ttlMs)
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}))
