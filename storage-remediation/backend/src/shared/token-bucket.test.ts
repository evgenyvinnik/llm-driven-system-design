import { describe, expect, it } from 'vitest'
import { MemoryBuckets, MIN_RATE_SHARE } from '../executor/buckets.js'
import { parseRetryAfter, take } from './token-bucket.js'

const headers = (h: Record<string, string>) => ({ get: (name: string) => h[name.toLowerCase()] ?? null })

describe('token bucket', () => {
  const cfg = { capacity: 3, refillPerSec: 1 }

  it('allows a burst up to capacity, then reports the wait for the next token', () => {
    let state = undefined
    for (let i = 0; i < 3; i++) {
      const r = take(state, cfg, 0)
      expect(r.ok).toBe(true)
      state = r.state
    }
    const denied = take(state, cfg, 0)
    expect(denied).toMatchObject({ ok: false, waitMs: 1000 })
    expect(take(denied.state, cfg, 400).waitMs).toBe(600)
    expect(take(denied.state, cfg, 1000).ok).toBe(true)
  })

  it('never refills above capacity', () => {
    const r = take({ tokens: 0, updatedAt: 0 }, cfg, 3_600_000)
    expect(r.state.tokens).toBe(2)
  })
})

describe('Retry-After parsing', () => {
  it('reads seconds, HTTP dates and the Resource Graph quota header', () => {
    expect(parseRetryAfter(headers({ 'retry-after': '7' }), 0)).toBe(7000)
    expect(parseRetryAfter(headers({ 'retry-after': new Date(10_000).toUTCString() }), 4000)).toBe(6000)
    expect(parseRetryAfter(headers({ 'x-ms-user-quota-resets-after': '00:00:03' }), 0)).toBe(3000)
    expect(parseRetryAfter(headers({}), 0, 1500)).toBe(1500)
  })
})

describe('per-subscription buckets with 429 back-off (executor)', () => {
  it('blocks a subscription for the Retry-After across callers, independently of others', async () => {
    let now = 0
    const buckets = new MemoryBuckets({ capacity: 5, refillPerSec: 2 }, () => now)
    expect(await buckets.take('sub-a')).toBe(0)
    await buckets.penalize('sub-a', 4000)
    expect(await buckets.take('sub-a')).toBe(4000)
    expect(await buckets.take('sub-b')).toBe(0)
    now = 4000
    // Bucket was emptied by the 429 and the rate halved (2/s → 1/s): the next token takes 1 s, not 0.
    expect(await buckets.take('sub-a')).toBe(1000)
    now = 5000
    expect(await buckets.take('sub-a')).toBe(0)
  })

  it('halves the rate on each 429 down to a floor, and recovers additively on success', async () => {
    let now = 0
    const buckets = new MemoryBuckets({ capacity: 100, refillPerSec: 10 }, () => now)
    for (let i = 0; i < 10; i++) await buckets.penalize('sub', 1)
    expect(buckets.rateOf('sub')).toBeCloseTo(10 * MIN_RATE_SHARE)
    now = 1_000_000
    for (let i = 0; i < 20; i++) expect(await buckets.take('sub')).toBe(0)
    expect(buckets.rateOf('sub')).toBeCloseTo(0.5 + 20 * 0.2)
  })
})
