import { describe, expect, it } from 'vitest'
import { chiSquareGof, chiSquareSf, compareProportions, normalCdf, twoSidedP, wilsonInterval } from './stats.js'

describe('normal distribution', () => {
  it('matches standard table values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7)
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 5)
    expect(twoSidedP(1.959964)).toBeCloseTo(0.05, 5)
    expect(twoSidedP(2.575829)).toBeCloseTo(0.01, 5)
  })
})

describe('wilsonInterval', () => {
  it('matches the textbook example (81/263 → [0.2553, 0.3662])', () => {
    const [lo, hi] = wilsonInterval(81, 263)
    expect(lo).toBeCloseTo(0.2553, 3)
    expect(hi).toBeCloseTo(0.3662, 3)
  })
  it('stays inside [0, 1] at the edges, where p ± z·SE would not', () => {
    const [lo0, hi0] = wilsonInterval(0, 20)
    expect(lo0).toBe(0)
    expect(hi0).toBeGreaterThan(0.1)
    const [lo1, hi1] = wilsonInterval(20, 20)
    expect(hi1).toBe(1)
    expect(lo1).toBeLessThan(0.9)
    expect(wilsonInterval(0, 0)).toEqual([0, 0])
  })
})

describe('compareProportions', () => {
  it('computes the pooled z-test (10% of 2000 vs 13% of 2000 → z ≈ 2.974, p ≈ 0.0029)', () => {
    const r = compareProportions(200, 2000, 260, 2000)
    expect(r.absDiff).toBeCloseTo(0.03, 10)
    expect(r.relLift).toBeCloseTo(0.3, 10)
    expect(r.z).toBeCloseTo(2.974, 2)
    expect(r.pValue).toBeCloseTo(0.003, 3)
    expect(r.absLow).toBeGreaterThan(0)
    expect(r.relLow!).toBeGreaterThan(0)
  })
  it('reports no effect for identical rates', () => {
    const r = compareProportions(100, 1000, 100, 1000)
    expect(r.z).toBe(0)
    expect(r.pValue).toBeCloseTo(1, 6)
    expect(r.absLow).toBeLessThan(0)
    expect(r.absHigh).toBeGreaterThan(0)
  })
  it('has no relative lift when control never converts', () => {
    expect(compareProportions(0, 100, 5, 100).relLift).toBeNull()
  })
})

describe('chi-square', () => {
  it('matches critical values', () => {
    expect(chiSquareSf(3.841459, 1)).toBeCloseTo(0.05, 5)
    expect(chiSquareSf(10.827566, 1)).toBeCloseTo(0.001, 5)
    expect(chiSquareSf(5.991465, 2)).toBeCloseTo(0.05, 5)
    expect(chiSquareSf(27.877165, 9)).toBeCloseTo(0.001, 5)
    expect(chiSquareSf(0, 3)).toBe(1)
  })
  it('flags a 50/50 experiment that came out 5200/4800 (p ≈ 6e-5) but not 5050/4950', () => {
    const bad = chiSquareGof([5200, 4800], [5000, 5000])
    expect(bad.chi2).toBeCloseTo(16, 6)
    expect(bad.pValue).toBeLessThan(0.001)
    const fine = chiSquareGof([5050, 4950], [5000, 5000])
    expect(fine.pValue).toBeGreaterThan(0.3)
  })
})
