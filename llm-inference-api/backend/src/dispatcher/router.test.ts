import { describe, expect, it } from 'vitest'
import { HashRing, membershipChange, route, type BackendLoad } from './router.js'

const opts = { epsilon: 0.25, lowLoadFraction: 0.5 }
const keys = Array.from({ length: 5000 }, (_, i) => `prefix-${i}`)

function loads(spec: Record<string, Partial<BackendLoad>>): Map<string, BackendLoad> {
  return new Map(Object.entries(spec).map(([id, b]) => [id, { id, routable: true, inUse: 0, slots: 8, ...b }]))
}

describe('hash ring', () => {
  it('is deterministic and gives every backend a fair share', () => {
    const ring = new HashRing(['b1', 'b2', 'b3'])
    expect(ring.owner('abc')).toBe(new HashRing(['b1', 'b2', 'b3']).owner('abc'))
    const counts: Record<string, number> = { b1: 0, b2: 0, b3: 0 }
    for (const k of keys) counts[ring.owner(k) as string]++
    for (const n of Object.values(counts)) expect(Math.abs(n / keys.length - 1 / 3)).toBeLessThan(0.04)
  })

  it('preference lists every backend once, owner first', () => {
    const ring = new HashRing(['b1', 'b2', 'b3'])
    const pref = ring.preference('k')
    expect(new Set(pref).size).toBe(3)
    expect(pref[0]).toBe(ring.owner('k'))
  })
})

describe('membership changes', () => {
  it('adding a fourth backend moves about a quarter of keys, all to the new one', () => {
    const change = membershipChange(['b1', 'b2', 'b3'], ['b1', 'b2', 'b3', 'b4'], keys)
    expect(change.movedConsistent).toBeGreaterThan(0.15)
    expect(change.movedConsistent).toBeLessThan(0.35)
    expect(change.movedModulo).toBeGreaterThan(0.6)
    const r1 = new HashRing(['b1', 'b2', 'b3'])
    const r2 = new HashRing(['b1', 'b2', 'b3', 'b4'])
    for (const k of keys.slice(0, 500)) {
      if (r1.owner(k) !== r2.owner(k)) expect(r2.owner(k)).toBe('b4')
    }
  })

  it('removing a backend moves only the keys it owned', () => {
    const r1 = new HashRing(['b1', 'b2', 'b3'])
    const r2 = new HashRing(['b1', 'b3'])
    for (const k of keys.slice(0, 500)) {
      if (r1.owner(k) !== 'b2') expect(r2.owner(k)).toBe(r1.owner(k))
    }
  })
})

describe('bounded-load routing', () => {
  const ring = new HashRing(['b1', 'b2', 'b3'])
  const key = 'system-prompt-A'
  const primary = ring.owner(key) as string

  it('routes to the prefix owner when it has room', () => {
    expect(route(ring, key, loads({ b1: {}, b2: {}, b3: {} }), opts)).toEqual({ backendId: primary, affinity: 'primary' })
  })

  it('keeps affinity below the low-load floor even if others are idle', () => {
    const l = loads({ b1: {}, b2: {}, b3: {} })
    l.get(primary)!.inUse = 3 // floor(8 × 0.5) = 4 → one more fits
    expect(route(ring, key, l, opts)?.backendId).toBe(primary)
  })

  it('spills to the next backend on the ring when the owner exceeds the bound', () => {
    const l = loads({ b1: {}, b2: {}, b3: {} })
    l.get(primary)!.inUse = 4
    const d = route(ring, key, l, opts)
    expect(d?.affinity).toBe('spill')
    expect(d?.spillReason).toBe('load_bound')
    expect(d?.backendId).toBe(ring.preference(key)[1])
  })

  it('skips a draining owner and a full backend', () => {
    const l = loads({ b1: {}, b2: {}, b3: {} })
    l.get(primary)!.routable = false
    const second = ring.preference(key)[1]
    l.get(second)!.inUse = 8
    const d = route(ring, key, l, opts)
    expect(d?.backendId).toBe(ring.preference(key)[2])
    expect(d?.spillReason).toBe('not_routable')
  })

  it('returns null when nothing is routable or everything is full', () => {
    expect(route(ring, key, loads({ b1: { routable: false }, b2: { routable: false }, b3: { routable: false } }), opts)).toBeNull()
    expect(route(ring, key, loads({ b1: { inUse: 8 }, b2: { inUse: 8 }, b3: { inUse: 8 } }), opts)).toBeNull()
  })

  it('one hot prefix spreads instead of overloading its owner', () => {
    const l = loads({ b1: {}, b2: {}, b3: {} })
    for (let i = 0; i < 18; i++) {
      const d = route(ring, key, l, opts)!
      l.get(d.backendId)!.inUse++
    }
    for (const b of l.values()) expect(b.inUse).toBeLessThanOrEqual(8)
    expect(l.get(primary)!.inUse).toBeLessThanOrEqual(Math.ceil((18 / 3) * 1.25))
  })
})
