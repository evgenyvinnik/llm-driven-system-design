/**
 * Live updates. One EventSource per tab. Server events are invalidations
 * ("train T03 changed"), so the store only counts them; pages watch the
 * counters and refetch through the normal endpoints. While the stream is down
 * pages fall back to polling, and every reconnect bumps the counters so a
 * page catches up on whatever it missed.
 */
import { create } from 'zustand'

type Kind = 'train' | 'plan' | 'alert' | 'order' | 'price' | 'ticket'

interface LiveState {
  connected: boolean
  /** Bumped on any event of that kind. */
  ticks: Record<Kind, number>
  /** Bumped on any event for that train. */
  trainTicks: Record<string, number>
  connect: () => void
  disconnect: () => void
}

let source: EventSource | null = null

export const useLiveStore = create<LiveState>((set, get) => ({
  connected: false,
  ticks: { train: 0, plan: 0, alert: 0, order: 0, price: 0, ticket: 0 },
  trainTicks: {},
  connect() {
    if (source) return
    source = new EventSource('/api/v1/events')
    const bumpAll = () =>
      set((s) => ({
        ticks: Object.fromEntries(Object.entries(s.ticks).map(([k, v]) => [k, v + 1])) as Record<Kind, number>,
      }))
    source.addEventListener('hello', () => {
      set({ connected: true })
      bumpAll()
    })
    source.onerror = () => set({ connected: false })
    for (const kind of ['train', 'plan', 'alert', 'order', 'price', 'ticket'] as Kind[]) {
      source.addEventListener(kind, (e) => {
        const data = JSON.parse((e as MessageEvent).data) as { trainId?: string }
        const { ticks, trainTicks } = get()
        set({
          ticks: { ...ticks, [kind]: ticks[kind] + 1 },
          trainTicks: data.trainId ? { ...trainTicks, [data.trainId]: (trainTicks[data.trainId] ?? 0) + 1 } : trainTicks,
        })
      })
    }
  },
  disconnect() {
    source?.close()
    source = null
    set({ connected: false })
  },
}))
