/**
 * Whether the server is reachable. Seeded from navigator.onLine and the
 * browser's online/offline events, then corrected by real requests: any
 * response means reachable, a fetch that fails to connect means not. Offline
 * mode is read-only: cached conversations stay readable, sending is disabled.
 */
import { create } from 'zustand'

interface ConnectivityState {
  online: boolean
  reportUnreachable: () => void
  reportReachable: () => void
}

export const useConnectivity = create<ConnectivityState>((set, get) => ({
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  reportUnreachable: () => {
    if (get().online) set({ online: false })
  },
  reportReachable: () => {
    if (!get().online) set({ online: true })
  },
}))

if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => useConnectivity.getState().reportUnreachable())
  // "online" only means a network exists; the next request confirms the server is reachable.
  window.addEventListener('online', () => useConnectivity.getState().reportReachable())
}
