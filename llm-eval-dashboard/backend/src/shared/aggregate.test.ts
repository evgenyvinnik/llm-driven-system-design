import { describe, expect, it } from 'vitest'
import { aggregateCases, aggregateRun, caseMeans, type SampleRow } from './aggregate.js'

const row = (caseKey: string, sampleIndex: number, status: SampleRow['status'], score: number | null, passed?: boolean): SampleRow => ({ caseKey, sampleIndex, status, score, passed: passed ?? (score === null ? null : score >= 1) })

describe('aggregateRun', () => {
  it('averages over successful cases only and reports what it left out', () => {
    const rows = [
      row('a', 0, 'succeeded', 1),
      row('a', 1, 'succeeded', 1),
      row('b', 0, 'succeeded', 0),
      row('b', 1, 'succeeded', 1),
      row('c', 0, 'errored', null),
      row('c', 1, 'errored', null),
      row('d', 0, 'succeeded', 1),
      row('d', 1, 'errored', null),
      row('e', 0, 'succeeded', null), // scored later
      row('e', 1, 'succeeded', null),
    ]
    const agg = aggregateRun(rows)
    // case means: a 1, b 0.5, d 1 (c errored, e unscored) → mean 0.8333
    expect(agg.scoredCases).toBe(3)
    expect(agg.mean).toBeCloseTo(2.5 / 3, 10)
    expect(agg.erroredTasks).toBe(3)
    expect(agg.erroredCases).toBe(1)
    expect(agg.partialCases).toBe(1)
    expect(agg.unscoredCases).toBe(1)
    expect(agg.unscoredTasks).toBe(2)
    expect(agg.flakyCases).toBe(1) // b disagrees
    expect(agg.ci).not.toBeNull()
  })

  it('never silently treats an errored sample as zero', () => {
    const withErrors = aggregateRun([row('a', 0, 'succeeded', 1), row('a', 1, 'errored', null), row('b', 0, 'succeeded', 1)])
    expect(withErrors.mean).toBe(1)
    expect(withErrors.erroredTasks).toBe(1)
  })

  it('gives no interval with fewer than two scored cases', () => {
    const agg = aggregateRun([row('a', 0, 'succeeded', 1), row('b', 0, 'errored', null)])
    expect(agg.mean).toBe(1)
    expect(agg.ci).toBeNull()
  })

  it('narrows when per-case noise is averaged over more samples', () => {
    // Each case has a true rate; samples are Bernoulli-like noise around it.
    const rates = [0.9, 0.5, 0.7, 0.3, 0.8, 0.6, 0.4, 0.95, 0.55, 0.65]
    const build = (k: number) =>
      rates.flatMap((r, i) => Array.from({ length: k }, (_, s) => row(`c${i}`, s, 'succeeded', ((i * 7 + s * 13) % 100) / 100 < r ? 1 : 0)))
    const w1 = aggregateRun(build(1)).ciHalfWidth!
    const w20 = aggregateRun(build(20)).ciHalfWidth!
    expect(w20).toBeLessThan(w1)
  })
})

describe('aggregateCases / caseMeans', () => {
  it('computes per-case variance and drops unscored cases from the means', () => {
    const cases = aggregateCases([row('a', 0, 'succeeded', 0.5), row('a', 1, 'succeeded', 1), row('b', 0, 'cancelled', null)])
    const a = cases.find((c) => c.caseKey === 'a')!
    expect(a.mean).toBe(0.75)
    expect(a.variance).toBeCloseTo(0.125, 10)
    expect(a.flaky).toBe(true)
    expect([...caseMeans([row('a', 0, 'succeeded', 1), row('b', 0, 'errored', null)]).keys()]).toEqual(['a'])
  })
})
