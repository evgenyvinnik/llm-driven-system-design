import { describe, expect, it } from 'vitest'
import { bootstrapInterval, mean, pairedComparison, tCdf, tInterval, tQuantile, variance, verdictFromInterval, welchInterval } from './stats.js'

describe('Student t', () => {
  it('matches tabulated 97.5% quantiles', () => {
    // Reference values from R: qt(0.975, df)
    expect(tQuantile(0.975, 1)).toBeCloseTo(12.706205, 4)
    expect(tQuantile(0.975, 4)).toBeCloseTo(2.776445, 5)
    expect(tQuantile(0.975, 9)).toBeCloseTo(2.262157, 5)
    expect(tQuantile(0.975, 21)).toBeCloseTo(2.079614, 5)
    expect(tQuantile(0.975, 100)).toBeCloseTo(1.983972, 5)
    expect(tQuantile(0.975, 7.5)).toBeCloseTo(2.335, 2) // fractional df (Welch)
  })

  it('has a symmetric CDF', () => {
    expect(tCdf(0, 5)).toBeCloseTo(0.5, 10)
    expect(tCdf(2.015048, 5)).toBeCloseTo(0.95, 5)
    expect(tCdf(-2.015048, 5)).toBeCloseTo(0.05, 5)
  })
})

describe('tInterval', () => {
  it('computes the textbook interval', () => {
    // mean 3, sd sqrt(2.5), se 0.7071, t(4) = 2.776445 → ±1.963243
    const ci = tInterval([1, 2, 3, 4, 5])
    expect(ci.mean).toBe(3)
    expect(ci.sd).toBeCloseTo(1.5811388, 6)
    expect(ci.lo).toBeCloseTo(1.036757, 5)
    expect(ci.hi).toBeCloseTo(4.963243, 5)
  })

  it('is undefined for a single value and zero-width for constant values', () => {
    expect(Number.isNaN(tInterval([0.7]).lo)).toBe(true)
    const flat = tInterval([1, 1, 1])
    expect(flat.lo).toBe(1)
    expect(flat.hi).toBe(1)
  })
})

describe('pairedComparison', () => {
  it('pairs by case and counts wins, losses and ties', () => {
    const pairs = [
      { a: 0.2, b: 0.6 },
      { a: 0.4, b: 0.8 },
      { a: 1, b: 1 },
      { a: 0.6, b: 0.4 },
      { a: 0, b: 0.6 },
    ]
    const r = pairedComparison(pairs)
    // diffs: .4 .4 0 -.2 .6 → mean .24, sum of squares .432, sd sqrt(.108) = 0.3286335, se 0.1469694
    expect(r.meanDiff).toBeCloseTo(0.24, 10)
    expect(r.sdDiff).toBeCloseTo(0.3286335, 6)
    expect(r.ci[0]).toBeCloseTo(0.24 - 2.776445 * 0.1469694, 5)
    expect(r.ci[1]).toBeCloseTo(0.24 + 2.776445 * 0.1469694, 5)
    expect([r.wins, r.losses, r.ties]).toEqual([3, 1, 1])
    expect(r.verdict).toBe('not_significant') // the interval crosses zero
  })

  it('calls a consistent gain significant', () => {
    const pairs = Array.from({ length: 20 }, (_, i) => ({ a: 0.5, b: 0.6 + (i % 3) * 0.05 }))
    const r = pairedComparison(pairs)
    expect(r.ci[0]).toBeGreaterThan(0)
    expect(r.verdict).toBe('improvement')
  })

  it('removes between-case spread that an unpaired test would keep', () => {
    // Cases differ wildly in difficulty; B is always exactly 0.05 better.
    const a = [0.1, 0.9, 0.3, 0.7, 0.5, 0.2, 0.8, 0.4]
    const pairs = a.map((x) => ({ a: x, b: x + 0.05 }))
    expect(pairedComparison(pairs).verdict).toBe('improvement')
    expect(welchInterval(a, a.map((x) => x + 0.05)).verdict).toBe('not_significant')
  })
})

describe('welchInterval', () => {
  it('uses Welch-Satterthwaite degrees of freedom', () => {
    // A = 1,1,2,3,3 (mean 2, var 1); B = 2,4,4,5,6 (mean 4.2, var 2.2)
    // se² = 1/5 + 2.2/5 = 0.64; df = 0.64² / (0.2²/4 + 0.44²/4) = 7.0137
    const r = welchInterval([1, 1, 2, 3, 3], [2, 4, 4, 5, 6])
    expect(r.meanDiff).toBeCloseTo(2.2, 10)
    expect(r.df).toBeCloseTo(7.0137, 3)
    const q = tQuantile(0.975, r.df) // ≈ 2.3639, between qt(.975, 7) = 2.3646 and qt(.975, 8) = 2.3060
    expect(q).toBeLessThan(2.3646)
    expect(q).toBeGreaterThan(2.306)
    expect(r.ci[0]).toBeCloseTo(2.2 - q * 0.8, 10)
    expect(r.ci[1]).toBeCloseTo(2.2 + q * 0.8, 10)
    expect(r.verdict).toBe('improvement')
  })
})

describe('bootstrapInterval', () => {
  it('is deterministic for a seed and close to the t-interval on well-behaved data', () => {
    const values = Array.from({ length: 40 }, (_, i) => Math.sin(i) * 0.3 + 0.6)
    const b1 = bootstrapInterval(values, { seed: 7 })
    const b2 = bootstrapInterval(values, { seed: 7 })
    expect(b1).toEqual(b2)
    const t = tInterval(values)
    expect(Math.abs(b1.lo - t.lo)).toBeLessThan(0.02)
    expect(Math.abs(b1.hi - t.hi)).toBeLessThan(0.02)
  })
})

describe('helpers', () => {
  it('mean and variance', () => {
    expect(mean([1, 2, 3])).toBe(2)
    expect(variance([1, 2, 3])).toBe(1)
    expect(variance([5])).toBe(0)
  })

  it('verdict needs the interval to exclude zero', () => {
    expect(verdictFromInterval(0.01, 0.2, 10)).toBe('improvement')
    expect(verdictFromInterval(-0.2, -0.01, 10)).toBe('regression')
    expect(verdictFromInterval(-0.01, 0.2, 10)).toBe('not_significant')
    expect(verdictFromInterval(0.1, 0.2, 1)).toBe('insufficient_data')
  })
})
