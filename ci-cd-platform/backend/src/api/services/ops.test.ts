import { describe, expect, it } from 'vitest'
import { peakConcurrency, percentile } from './ops.js'

describe('peakConcurrency', () => {
  it('counts overlapping intervals', () => {
    expect(peakConcurrency([{ start: 0, end: 10 }, { start: 5, end: 15 }, { start: 8, end: 9 }, { start: 20, end: 30 }])).toBe(3)
  })

  it('an interval ending exactly when another starts does not overlap it', () => {
    expect(peakConcurrency([{ start: 0, end: 10 }, { start: 10, end: 20 }])).toBe(1)
  })

  it('is zero with nothing to count', () => {
    expect(peakConcurrency([])).toBe(0)
  })
})

describe('percentile', () => {
  it('reads from a sorted list', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(3)
    expect(percentile([1, 2, 3, 4], 1)).toBe(4)
    expect(percentile([], 0.5)).toBe(0)
  })
})
