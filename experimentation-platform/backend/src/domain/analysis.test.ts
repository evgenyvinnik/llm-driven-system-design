import { describe, expect, it } from 'vitest'
import { allocateStable } from '../shared/evaluation.js'
import { analyze } from './analysis.js'

const fiftyFifty = allocateStable({}, { control: 5000, treatment: 5000 })

describe('analyze', () => {
  it('computes rates, intervals, lift and a clean SRM for a healthy experiment', () => {
    const result = analyze({
      variants: ['control', 'treatment'],
      control: 'control',
      rows: [
        { variant: 'control', version: 2, units: 2010, crossovers: 10, conversions: 200 },
        { variant: 'treatment', version: 2, units: 1990, crossovers: 10, conversions: 257 },
      ],
      allocations: new Map([[2, fiftyFifty]]),
      current: fiftyFifty,
    })
    expect(result.totalUnits).toBe(4000)
    expect(result.crossovers).toBe(20)
    const [c, t] = result.arms
    expect(c.analyzedUnits).toBe(2000)
    expect(c.rate).toBeCloseTo(0.1, 10)
    expect(t.rate).toBeCloseTo(257 / 1980, 10)
    expect(c.lift).toBeNull()
    expect(t.lift!.significant).toBe(true)
    expect(t.lift!.relLift!).toBeGreaterThan(0.25)
    expect(c.ci[0]).toBeLessThan(0.1)
    expect(c.ci[1]).toBeGreaterThan(0.1)
    expect(result.srm!.flagged).toBe(false)
    expect(c.expectedUnits).toBeCloseTo(2000, 6)
  })

  it('flags SRM when one arm lost a fifth of its exposures', () => {
    const result = analyze({
      variants: ['control', 'treatment'],
      control: 'control',
      rows: [
        { variant: 'control', version: 1, units: 2500, crossovers: 0, conversions: 250 },
        { variant: 'treatment', version: 1, units: 2000, crossovers: 0, conversions: 200 },
      ],
      allocations: new Map([[1, fiftyFifty]]),
      current: fiftyFifty,
    })
    expect(result.srm!.flagged).toBe(true)
    expect(result.srm!.pValue).toBeLessThan(1e-6)
  })

  it('computes the expected split per config version, so a ramp is not an SRM', () => {
    const v1 = allocateStable({}, { control: 9000, treatment: 1000 })
    const v2 = allocateStable(v1, { control: 8000, treatment: 2000 })
    const result = analyze({
      variants: ['control', 'treatment'],
      control: 'control',
      rows: [
        { variant: 'control', version: 1, units: 4500, crossovers: 0, conversions: 0 },
        { variant: 'treatment', version: 1, units: 500, crossovers: 0, conversions: 0 },
        { variant: 'control', version: 2, units: 4000, crossovers: 0, conversions: 0 },
        { variant: 'treatment', version: 2, units: 1000, crossovers: 0, conversions: 0 },
      ],
      allocations: new Map([
        [1, v1],
        [2, v2],
      ]),
      current: v2,
    })
    expect(result.arms[1].expectedUnits).toBeCloseTo(1500, 6)
    expect(result.srm!.flagged).toBe(false)
    // Against the current weights alone, the same data would look broken.
    const naive = analyze({ variants: ['control', 'treatment'], control: 'control', rows: result.arms.map((a) => ({ variant: a.variant, version: 9, units: a.units, crossovers: 0, conversions: 0 })), allocations: new Map(), current: v2 })
    expect(naive.srm!.flagged).toBe(true)
  })

  it('normalizes expected shares over enrolled buckets when the experiment covers part of the traffic', () => {
    const partial = allocateStable({}, { control: 1000, treatment: 1000 })
    const result = analyze({
      variants: ['control', 'treatment'],
      control: 'control',
      rows: [
        { variant: 'control', version: 1, units: 500, crossovers: 0, conversions: 0 },
        { variant: 'treatment', version: 1, units: 500, crossovers: 0, conversions: 0 },
      ],
      allocations: new Map([[1, partial]]),
      current: partial,
    })
    expect(result.arms[0].expectedShare).toBeCloseTo(0.5, 10)
    expect(result.srm!.flagged).toBe(false)
  })

  it('declines to run SRM with too little data', () => {
    const result = analyze({
      variants: ['control', 'treatment'],
      control: 'control',
      rows: [{ variant: 'control', version: 1, units: 3, crossovers: 0, conversions: 0 }],
      allocations: new Map([[1, fiftyFifty]]),
      current: fiftyFifty,
    })
    expect(result.srm).toBeNull()
  })
})
