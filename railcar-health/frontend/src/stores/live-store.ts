/**
 * Live-update state. SSE notices bump a per-topic revision; pages list the
 * revisions they care about as effect dependencies and refetch. The REST read
 * stays the source of truth, so a dropped connection only delays a refresh.
 */
import { create } from 'zustand'

export type Topic = 'alerts' | 'trips' | 'detectors' | 'yard'

interface LiveState {
  connected: boolean
  revisions: Record<Topic, number>
  lastAlertId: string | null
  setConnected: (connected: boolean) => void
  bump: (topics: Topic[], alertId?: string) => void
}

export const useLiveStore = create<LiveState>((set) => ({
  connected: false,
  revisions: { alerts: 0, trips: 0, detectors: 0, yard: 0 },
  lastAlertId: null,
  setConnected: (connected) => set({ connected }),
  bump: (topics, alertId) =>
    set((s) => {
      const revisions = { ...s.revisions }
      for (const t of topics) revisions[t] += 1
      return { revisions, lastAlertId: alertId ?? s.lastAlertId }
    }),
}))
