import { create } from 'zustand'
import type { Clock } from '@/types'

interface ClockState extends Clock {
  update: (c: Clock) => void
}

/** The domain clock from the server (simulated while the simulator runs). */
export const useClockStore = create<ClockState>((set) => ({
  now: new Date().toISOString(),
  speed: 1,
  simulated: false,
  update: (c) => set(c),
}))
