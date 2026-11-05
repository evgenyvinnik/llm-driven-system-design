import { describe, expect, it } from 'vitest'
import { biasEstimate, biasSample, detectorStatus, detectorsOnRoute, expectedPassStatuses } from './detector-health.js'

describe('bias detection', () => {
  it('compares a detector with its neighbours on the same train', () => {
    expect(biasSample(20, 40, 42)).toBe(-21)
    expect(biasSample(20, 40, null)).toBeNull()
  })

  it('flags a consistent offset only after enough trains', () => {
    expect(biasEstimate([-21, -19], 12, 3).biased).toBe(false)
    const est = biasEstimate([-21, -19, -20], 12, 3)
    expect(est.biased).toBe(true)
    expect(est.offset).toBeCloseTo(-20)
    // A braking-zone detector that runs a few degrees warm for everyone is not biased.
    expect(biasEstimate([6, 5, 7, 6], 12, 3).biased).toBe(false)
  })
})

describe('expected passes', () => {
  const route = detectorsOnRoute(
    [{ id: 'A', milepost: 10 }, { id: 'B', milepost: 25 }, { id: 'C', milepost: 40 }, { id: 'D', milepost: 55 }],
    'WB', 60, 0,
  )

  it('orders the route in the direction of travel', () => {
    expect(route.map((d) => d.id)).toEqual(['D', 'C', 'B', 'A'])
  })

  it('marks skipped detectors missing up to the furthest one seen, and flips them back when late data arrives', () => {
    expect(expectedPassStatuses(route, new Set(['D', 'B']))).toEqual([
      { detectorId: 'D', status: 'received' },
      { detectorId: 'C', status: 'missing' },
      { detectorId: 'B', status: 'received' },
    ])
    expect(expectedPassStatuses(route, new Set(['D', 'B', 'C'])).every((s) => s.status === 'received')).toBe(true)
  })
})

describe('detector status', () => {
  const base = { nowMs: 100 * 60_000, offlineAfterMs: 25 * 60_000, missedRecent: 0, biased: false, biasOffset: null }

  it('prefers offline (data may still come) over silent (data never comes) over biased', () => {
    expect(detectorStatus({ ...base, lastHeardAtMs: 0, missedRecent: 3 }).status).toBe('offline')
    expect(detectorStatus({ ...base, lastHeardAtMs: 95 * 60_000, missedRecent: 2, biased: true, biasOffset: -20 }).status).toBe('silent')
    const biased = detectorStatus({ ...base, lastHeardAtMs: 95 * 60_000, biased: true, biasOffset: -20 })
    expect(biased).toEqual({ status: 'biased', reason: 'Reads 20°F low vs neighbouring detectors on the same trains' })
    expect(detectorStatus({ ...base, lastHeardAtMs: 95 * 60_000 }).status).toBe('ok')
  })
})
