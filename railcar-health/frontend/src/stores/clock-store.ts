/**
 * The domain clock as the server sees it. Locally the simulator compresses
 * time, so "12 min ago" must be computed from the server's clock, not the
 * browser's. Every list response carries the clock; we keep the latest and
 * extrapolate between responses.
 */
import { create } from 'zustand'
import type { Clock } from '@/types'

interface ClockState {
  serverNowMs: number
  fetchedAtMs: number
  speed: number
  simulated: boolean
  update: (clock: Clock) => void
  now: () => number
}

export const useClockStore = create<ClockState>((set, get) => ({
  serverNowMs: Date.now(),
  fetchedAtMs: Date.now(),
  speed: 1,
  simulated: false,
  update(clock) {
    set({ serverNowMs: new Date(clock.now).getTime(), fetchedAtMs: Date.now(), speed: clock.speed, simulated: clock.simulated })
  },
  now() {
    const s = get()
    return s.serverNowMs + (Date.now() - s.fetchedAtMs) * s.speed
  },
}))
