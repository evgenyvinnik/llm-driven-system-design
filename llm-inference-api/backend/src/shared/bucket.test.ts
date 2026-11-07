import { describe, expect, it } from 'vitest'
import { bucketLevel, charge, limitsPerMinute, refundAmount, retryAfterSeconds } from './bucket.js'

const limits = limitsPerMinute(60_000) // 1 token per ms, burst 60k

describe('token bucket math', () => {
  it('a new bucket starts full', () => {
    expect(bucketLevel(null, 0, limits)).toBe(60_000)
  })

  it('refills continuously and caps at capacity', () => {
    expect(bucketLevel({ tokens: 0, updatedAt: 0 }, 500, limits)).toBe(500)
    expect(bucketLevel({ tokens: 59_900, updatedAt: 0 }, 10_000, limits)).toBe(60_000)
  })

  it('charges by cost and computes the wait for an over-budget request', () => {
    expect(charge({ tokens: 5000, updatedAt: 0 }, 0, limits, 3000)).toEqual({ ok: true, remaining: 2000 })
    const r = charge({ tokens: 1000, updatedAt: 0 }, 0, limits, 3000)
    expect(r).toMatchObject({ ok: false, reason: 'insufficient', retryAfterMs: 2000 })
  })

  it('two requests with the same prompt but different max_tokens cost differently', () => {
    const small = charge({ tokens: 4000, updatedAt: 0 }, 0, limits, 500 + 256)
    const large = charge({ tokens: 4000, updatedAt: 0 }, 0, limits, 500 + 4096)
    expect(small.ok).toBe(true)
    expect(large.ok).toBe(false)
  })

  it('rejects a request larger than the burst outright', () => {
    expect(charge(null, 0, limits, 60_001)).toMatchObject({ ok: false, reason: 'too_large' })
  })

  it('refunds only the unused reservation', () => {
    expect(refundAmount(1256, 700)).toBe(556)
    expect(refundAmount(1256, 2000)).toBe(0)
  })

  it('Retry-After is whole seconds, at least one', () => {
    expect(retryAfterSeconds(1)).toBe(1)
    expect(retryAfterSeconds(2001)).toBe(3)
  })
})
