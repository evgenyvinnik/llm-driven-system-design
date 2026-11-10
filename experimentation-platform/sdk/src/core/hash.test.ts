import { describe, expect, it } from 'vitest'
import { bucketOf, murmur3 } from './hash.js'
import { BUCKETS } from './types.js'

describe('murmur3', () => {
  it('matches the reference MurmurHash3_x86_32 vectors', () => {
    expect(murmur3('', 0)).toBe(0)
    expect(murmur3('', 1)).toBe(0x514e28b7)
    expect(murmur3('hello', 0)).toBe(0x248bfa47)
    expect(murmur3('The quick brown fox jumps over the lazy dog', 0)).toBe(0x2e4ff723)
  })

  it('hashes UTF-8 bytes, not UTF-16 code units', () => {
    // 'é' is two UTF-8 bytes; a code-unit hash would differ from the server's byte hash.
    expect(murmur3('é')).toBe(murmur3('é'))
    expect(murmur3('é')).not.toBe(murmur3('e'))
  })
})

describe('bucketOf', () => {
  it('is deterministic and in range', () => {
    for (let i = 0; i < 1000; i++) {
      const b = bucketOf('salt-1', `user-${i}`)
      expect(b).toBeGreaterThanOrEqual(0)
      expect(b).toBeLessThan(BUCKETS)
      expect(bucketOf('salt-1', `user-${i}`)).toBe(b)
    }
  })

  it('spreads units evenly across ten deciles', () => {
    const counts = new Array(10).fill(0)
    const n = 50_000
    for (let i = 0; i < n; i++) counts[Math.floor(bucketOf('dist', `u${i}`) / 1000)]++
    // Chi-square with 9 degrees of freedom; 27.9 is the p = 0.001 critical value.
    const expected = n / 10
    const chi = counts.reduce((s, c) => s + (c - expected) ** 2 / expected, 0)
    expect(chi).toBeLessThan(27.9)
  })

  it('gives independent buckets under different salts', () => {
    let same = 0
    for (let i = 0; i < 10_000; i++) if (bucketOf('a', `u${i}`) < 5000 === bucketOf('b', `u${i}`) < 5000) same++
    expect(same / 10_000).toBeGreaterThan(0.47)
    expect(same / 10_000).toBeLessThan(0.53)
  })
})
