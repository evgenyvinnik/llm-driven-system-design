/**
 * Latency, failure and capacity knobs for each mock dependency, and the
 * simulated work model. Pure functions so the model is unit-testable.
 * @module deps/knobs
 */
import { z } from 'zod'
import type { Dependency } from '../shared/domain.js'

export const knobSchema = z.object({
  /** Median service time in ms. */
  latencyMs: z.number().int().min(0).max(60_000),
  /** ± uniform jitter as a share of the latency. */
  jitterPct: z.number().min(0).max(100),
  /** Share of calls that hit the slow tail. */
  tailPct: z.number().min(0).max(100),
  tailMs: z.number().int().min(0).max(60_000),
  /** Share of calls that fail with 500 after their service time. */
  errorRate: z.number().min(0).max(100),
  /** Share of calls that hang until the caller's deadline (or 30 s). */
  hangRate: z.number().min(0).max(100),
  /** Concurrent calls served at once; the rest queue (and the queue wait counts against the deadline). */
  concurrency: z.number().int().min(1).max(10_000),
  /** Refuse every call immediately with 503. */
  down: z.boolean(),
})
export type Knobs = z.infer<typeof knobSchema>

export const DEFAULT_KNOBS: Record<Dependency, Knobs> = {
  pricing: { latencyMs: 60, jitterPct: 30, tailPct: 1, tailMs: 350, errorRate: 0, hangRate: 0, concurrency: 64, down: false },
  fuel: { latencyMs: 25, jitterPct: 30, tailPct: 0.5, tailMs: 200, errorRate: 0, hangRate: 0, concurrency: 64, down: false },
  capacity: { latencyMs: 120, jitterPct: 30, tailPct: 4, tailMs: 1_400, errorRate: 0, hangRate: 0, concurrency: 32, down: false },
  availability: { latencyMs: 90, jitterPct: 30, tailPct: 2, tailMs: 800, errorRate: 0, hangRate: 0, concurrency: 32, down: false },
}

export type Outcome = { kind: 'ok'; workMs: number } | { kind: 'error'; workMs: number } | { kind: 'hang' }

/** Decides what one call does. `rand` is injectable for tests. */
export function planCall(k: Knobs, rand: () => number = Math.random): Outcome {
  if (rand() * 100 < k.hangRate) return { kind: 'hang' }
  const tail = rand() * 100 < k.tailPct
  const base = tail ? k.tailMs : k.latencyMs
  const jitter = base * (k.jitterPct / 100) * (rand() * 2 - 1)
  const workMs = Math.max(0, Math.round(base + jitter))
  if (rand() * 100 < k.errorRate) return { kind: 'error', workMs }
  return { kind: 'ok', workMs }
}

/** A counting semaphore with a FIFO queue, standing in for a dependency's worker pool. */
export class Semaphore {
  private active = 0
  private readonly waiters: (() => void)[] = []

  constructor(public limit: number) {}

  get inUse(): number {
    return this.active
  }

  get queued(): number {
    return this.waiters.length
  }

  /** Resolves with a release function, or null if `deadlineAt` passes while still queued. */
  acquire(deadlineAt?: number): Promise<(() => void) | null> {
    const release = () => this.release()
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve(release)
    }
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined
      const waiter = () => {
        if (timer) clearTimeout(timer)
        this.active += 1
        resolve(release)
      }
      this.waiters.push(waiter)
      if (deadlineAt !== undefined) {
        timer = setTimeout(() => {
          const i = this.waiters.indexOf(waiter)
          if (i >= 0) this.waiters.splice(i, 1)
          resolve(null)
        }, Math.max(0, deadlineAt - Date.now()))
      }
    })
  }

  private release(): void {
    this.active -= 1
    if (this.active < this.limit) this.waiters.shift()?.()
  }
}
