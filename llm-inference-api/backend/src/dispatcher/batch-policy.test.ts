import { describe, expect, it } from 'vitest'
import { classCapacity, decideDispatch } from './batch-policy.js'

const cfg = { batchMaxSize: 4, maxWaitMs: 25, deadlineSlackMs: 2000 }
const now = 100_000

describe('batch dispatch policy', () => {
  it('dispatches a full batch immediately', () => {
    expect(decideDispatch({ depth: 6, oldestEnqueuedAt: now, earliestDeadline: null }, 8, cfg, now)).toEqual({ trigger: 'full', size: 4, oldestWaitMs: 0 })
  })

  it('waits while the batch is not full and the oldest is young', () => {
    expect(decideDispatch({ depth: 2, oldestEnqueuedAt: now - 10, earliestDeadline: null }, 8, cfg, now)).toBeNull()
  })

  it('a batch that never fills leaves when the oldest reaches max wait', () => {
    expect(decideDispatch({ depth: 1, oldestEnqueuedAt: now - 25, earliestDeadline: null }, 8, cfg, now)).toEqual({ trigger: 'max_wait', size: 1, oldestWaitMs: 25 })
  })

  it('dispatches early when a deadline is close', () => {
    const d = decideDispatch({ depth: 2, oldestEnqueuedAt: now - 5, earliestDeadline: now + 1500 }, 8, { ...cfg, maxWaitMs: 5000 }, now)
    expect(d?.trigger).toBe('deadline')
  })

  it('never exceeds free slots and dispatches nothing without capacity', () => {
    expect(decideDispatch({ depth: 10, oldestEnqueuedAt: now - 100, earliestDeadline: null }, 2, cfg, now)).toEqual({ trigger: 'max_wait', size: 2, oldestWaitMs: 100 })
    expect(decideDispatch({ depth: 10, oldestEnqueuedAt: now - 100, earliestDeadline: null }, 0, cfg, now)).toBeNull()
  })

  it('with the exercise numbers (100 per accelerator) a trickle still leaves on max wait', () => {
    const big = { batchMaxSize: 100, maxWaitMs: 50, deadlineSlackMs: 0 }
    expect(decideDispatch({ depth: 3, oldestEnqueuedAt: now - 49, earliestDeadline: null }, 100, big, now)).toBeNull()
    expect(decideDispatch({ depth: 3, oldestEnqueuedAt: now - 50, earliestDeadline: null }, 100, big, now)?.size).toBe(3)
  })
})

describe('class capacity', () => {
  it('interactive takes every free slot when bulk is at its share', () => {
    expect(classCapacity(10, 24, 6, true, true, 0.25)).toEqual({ interactive: 10, batch: 0 })
  })

  it('bulk below its guaranteed share keeps slots even under interactive pressure', () => {
    expect(classCapacity(10, 24, 2, true, true, 0.25)).toEqual({ interactive: 6, batch: 4 })
  })

  it('bulk may use free slots up to its ceiling when no interactive work waits', () => {
    expect(classCapacity(10, 24, 12, false, true, 0.25)).toEqual({ interactive: 10, batch: 10 })
    expect(classCapacity(10, 24, 12, false, true, 0.25, 0.75)).toEqual({ interactive: 10, batch: 6 })
    expect(classCapacity(6, 24, 18, false, true, 0.25, 0.75)).toEqual({ interactive: 6, batch: 0 })
  })
})
