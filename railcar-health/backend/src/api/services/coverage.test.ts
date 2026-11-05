import { describe, expect, it } from 'vitest'
import { coverageGaps } from './coverage.js'

describe('coverageGaps', () => {
  const detectors = [10, 25, 40, 55, 70].map((mp) => ({ id: `HBD-${mp}`, milepost: mp, status: 'ok' }))

  it('finds no gaps on a healthy line', () => {
    expect(coverageGaps(detectors, 0, 80, 20)).toEqual([])
  })

  it('reports the stretch a silent detector leaves uncovered, but not an offline one', () => {
    const silent = detectors.map((d) => (d.id === 'HBD-40' ? { ...d, status: 'silent' } : d))
    expect(coverageGaps(silent, 0, 80, 20)).toEqual([{ fromMp: 25, toMp: 55, miles: 30, causes: ['HBD-40'] }])
    const offline = detectors.map((d) => (d.id === 'HBD-40' ? { ...d, status: 'offline' } : d))
    expect(coverageGaps(offline, 0, 80, 20)).toEqual([])
  })
})
