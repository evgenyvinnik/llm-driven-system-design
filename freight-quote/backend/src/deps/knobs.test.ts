import { describe, expect, it } from 'vitest'
import { DEFAULT_KNOBS, planCall, Semaphore } from './knobs.js'

describe('mock dependency knobs', () => {
  it('sends a share of calls to the slow tail', () => {
    const k = { ...DEFAULT_KNOBS.capacity, jitterPct: 0, tailPct: 50, tailMs: 1_000, latencyMs: 100 }
    const seq = [0.9, 0.1, 0.5, 0.9] // hang? no; tail? yes (0.1*100 < 50); jitter; error? no
    let i = 0
    expect(planCall(k, () => seq[i++])).toEqual({ kind: 'ok', workMs: 1_000 })
  })

  it('injects errors and hangs', () => {
    expect(planCall({ ...DEFAULT_KNOBS.pricing, hangRate: 100 }).kind).toBe('hang')
    expect(planCall({ ...DEFAULT_KNOBS.pricing, errorRate: 100 }).kind).toBe('error')
  })

  it('queues past its concurrency and gives up a queued call at the deadline', async () => {
    const sem = new Semaphore(1)
    const release = await sem.acquire()
    expect(release).not.toBeNull()
    const t0 = Date.now()
    const queued = await sem.acquire(Date.now() + 30)
    expect(queued).toBeNull()
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25)
    const waiting = sem.acquire()
    release!()
    const next = await waiting
    expect(next).not.toBeNull()
    expect(sem.inUse).toBe(1)
  })
})
