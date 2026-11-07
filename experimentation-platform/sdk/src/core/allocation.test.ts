import { describe, expect, it } from 'vitest'
import {
  allocateContiguous,
  allocateStable,
  compareAllocations,
  expectedRehashChange,
  freeRanges,
  normalizeRanges,
  validateAllocation,
  variantAt,
  weightsOf,
} from './allocation.js'
import { bucketOf } from './hash.js'
import type { Allocation } from './types.js'

/** Fraction of sampled units whose variant differs between two (salt, allocation) pairs. */
function measuredSwitch(
  a: { salt: string; allocation: Allocation },
  b: { salt: string; allocation: Allocation },
  from: string | null = null,
  n = 20_000,
) {
  let changed = 0
  let base = 0
  let leftFrom = 0
  for (let i = 0; i < n; i++) {
    const id = `unit-${i}`
    const before = variantAt(a.allocation, bucketOf(a.salt, id))
    const after = variantAt(b.allocation, bucketOf(b.salt, id))
    if (before !== after) changed++
    if (from !== null && before === from) {
      base++
      if (after !== from) leftFrom++
    }
  }
  return { changed: changed / n, leftFrom: base ? leftFrom / base : 0 }
}

describe('normalizeRanges / freeRanges', () => {
  it('merges touching ranges and computes the complement', () => {
    expect(normalizeRanges([[10, 20], [0, 10], [30, 30], [25, 40]])).toEqual([[0, 20], [25, 40]])
    expect(freeRanges({ a: [[0, 100]], b: [[200, 300]] })).toEqual([[100, 200], [300, 10_000]])
  })
})

describe('allocateStable', () => {
  it('lays out a new experiment contiguously in weight order', () => {
    expect(allocateStable({}, { control: 5000, treatment: 5000 })).toEqual({ control: [[0, 5000]], treatment: [[5000, 10_000]] })
  })

  it('ramps treatment 10% → 20% by moving control units only', () => {
    const v1 = allocateStable({}, { control: 9000, treatment: 1000 })
    const v2 = allocateStable(v1, { control: 8000, treatment: 2000 })
    const move = compareAllocations(v1, v2)
    expect(weightsOf(v2)).toEqual({ control: 8000, treatment: 2000 })
    expect(move.changed).toBe(1000)
    expect(move.transitions).toEqual([{ from: 'control', to: 'treatment', buckets: 1000 }])
    expect(move.leaving.treatment.left).toBe(0)
  })

  it('never takes a bucket from a variant whose weight does not shrink', () => {
    let alloc = allocateStable({}, { a: 3000, b: 3000, c: 3000 })
    const steps = [
      { a: 4000, b: 2500, c: 2500 },
      { a: 4000, b: 3000, c: 1000 },
      { a: 2000, b: 3000, c: 5000 },
      { a: 2000, b: 2000, c: 2000 },
      { a: 3333, b: 3333, c: 3334 },
    ]
    for (const weights of steps) {
      const next = allocateStable(alloc, weights)
      expect(validateAllocation(next)).toBeNull()
      expect(weightsOf(next)).toEqual(weights)
      const before = weightsOf(alloc)
      const move = compareAllocations(alloc, next)
      for (const v of Object.keys(weights)) {
        if (weights[v as keyof typeof weights] >= before[v]) expect(move.leaving[v].left).toBe(0)
        else expect(move.leaving[v].left).toBe(before[v] - weights[v as keyof typeof weights])
      }
      alloc = next
    }
  })

  it('reuses released buckets before unallocated ones, minimising changed units', () => {
    const v1 = allocateStable({}, { a: 3000, b: 3000, c: 3000 })
    const v2 = allocateStable(v1, { a: 4000, b: 2500, c: 2500 })
    const move = compareAllocations(v1, v2)
    expect(move.changed).toBe(1000)
    expect(move.newlyEnrolled).toBe(0)
  })

  it('releases every bucket of a removed variant and rejects weights over 100%', () => {
    const v1 = allocateStable({}, { control: 5000, treatment: 5000 })
    expect(allocateStable(v1, { control: 5000 })).toEqual({ control: [[0, 5000]] })
    expect(() => allocateStable(v1, { control: 6000, treatment: 5000 })).toThrow(/more than 100%/)
  })
})

describe('stable ranges vs the naive alternatives (measured on 20,000 random units)', () => {
  it('10% → 20% treatment ramp: stable moves 10% (0% of treatment leaves); re-hashing moves ~26% (~80% of treatment leaves)', () => {
    const v1 = allocateStable({}, { control: 9000, treatment: 1000 })
    const stable = measuredSwitch({ salt: 's', allocation: v1 }, { salt: 's', allocation: allocateStable(v1, { control: 8000, treatment: 2000 }) }, 'treatment')
    const rehash = measuredSwitch(
      { salt: 's', allocation: v1 },
      { salt: 's:v2', allocation: allocateContiguous({ control: 8000, treatment: 2000 }) },
      'treatment',
    )
    expect(stable.changed).toBeGreaterThan(0.09)
    expect(stable.changed).toBeLessThan(0.11)
    expect(stable.leftFrom).toBe(0)
    expect(rehash.changed).toBeGreaterThan(0.24)
    expect(rehash.changed).toBeLessThan(0.28)
    expect(rehash.leftFrom).toBeGreaterThan(0.75)
    const expected = expectedRehashChange({ control: 9000, treatment: 1000 }, { control: 8000, treatment: 2000 })
    expect(expected.changed).toBeCloseTo(0.26, 5)
    expect(expected.leaving.treatment).toBeCloseTo(0.8, 5)
  })

  it('enrolment ramp 20% → 40% at 50/50: contiguous re-partitioning sends every treatment unit back to control', () => {
    const v1 = allocateStable({}, { control: 1000, treatment: 1000 })
    const stableV2 = allocateStable(v1, { control: 2000, treatment: 2000 })
    const naiveV2 = allocateContiguous({ control: 2000, treatment: 2000 })
    const stable = compareAllocations(v1, stableV2)
    const naive = compareAllocations(allocateContiguous({ control: 1000, treatment: 1000 }), naiveV2)
    expect(stable.switched).toBe(0)
    expect(stable.newlyEnrolled).toBe(2000)
    expect(naive.leaving.treatment.left).toBe(1000) // 100% of treatment switched to control
    expect(naive.switched).toBe(1000)
    const measured = measuredSwitch({ salt: 's', allocation: v1 }, { salt: 's', allocation: naiveV2 }, 'treatment')
    expect(measured.leftFrom).toBe(1)
  })

  it('three-way rebalance 34/33/33 → 50/25/25: contiguous moves 24% of units, stable 16%', () => {
    const before = { a: 3400, b: 3300, c: 3300 }
    const after = { a: 5000, b: 2500, c: 2500 }
    const v1 = allocateStable({}, before)
    const stable = compareAllocations(v1, allocateStable(v1, after))
    const naive = compareAllocations(allocateContiguous(before), allocateContiguous(after))
    expect(stable.changed).toBe(1600)
    expect(naive.changed).toBe(2400)
    expect(naive.leaving.c.left).toBe(800)
    expect(stable.leaving.c.left).toBe(800)
    expect(naive.leaving.b.left).toBe(1600) // b loses twice what it has to
    expect(stable.leaving.b.left).toBe(800)
  })
})
