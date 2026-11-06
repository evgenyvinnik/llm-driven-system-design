/**
 * Live-update state. SSE notices bump a per-topic revision; pages list the
 * revisions they care about as effect dependencies and refetch. The REST read
 * stays the source of truth, so a dropped connection only delays a refresh.
 */
import { create } from 'zustand'

export type Topic = 'hazards' | 'alerts' | 'restrictions' | 'trains' | 'coverage' | 'ops' | 'latency'
const ALL: Topic[] = ['hazards', 'alerts', 'restrictions', 'trains', 'coverage', 'ops', 'latency']

interface LiveState {
  connected: boolean
  revisions: Record<Topic, number>
  lastCritical: { hazardId: string; at: number } | null
  setConnected: (connected: boolean) => void
  bump: (topics: Topic[]) => void
  bumpAll: () => void
  flagCritical: (hazardId: string) => void
}

export const useLiveStore = create<LiveState>((set) => ({
  connected: false,
  revisions: Object.fromEntries(ALL.map((t) => [t, 0])) as Record<Topic, number>,
  lastCritical: null,
  setConnected: (connected) => set({ connected }),
  bump: (topics) =>
    set((s) => {
      const revisions = { ...s.revisions }
      for (const t of topics) if (t in revisions) revisions[t] += 1
      return { revisions }
    }),
  bumpAll: () => set((s) => ({ revisions: Object.fromEntries(ALL.map((t) => [t, s.revisions[t] + 1])) as Record<Topic, number> })),
  flagCritical: (hazardId) => set({ lastCritical: { hazardId, at: Date.now() } }),
}))
