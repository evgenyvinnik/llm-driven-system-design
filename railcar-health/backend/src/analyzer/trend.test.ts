import { describe, expect, it } from 'vitest'
import { buildObservations, computeFeatures, median, percentileRank, slope, type Observation, type PassContext, type ReadingRow } from './trend.js'

const opts = { elevatedSideDelta: 20, hotWheelDelta: 150, maxSpacingMiles: 20, historyElevatedTrips: 0 }

function obs(distance: number, sideDelta: number, extra: Partial<Observation> = {}): Observation {
  return {
    detectorId: `HBD-${distance}`, passId: `p${distance}`, milepost: distance, distance, passedAtMs: distance * 80_000,
    rawAboveAmbient: 40 + sideDelta, aboveAmbient: 40 + sideDelta, sideDelta, percentile: 99, wheelDelta: 0, lagSeconds: 0,
    edgeAlarm: false, biasCorrected: false, ...extra,
  }
}

describe('statistics helpers', () => {
  it('computes medians, percentile ranks and slopes', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(percentileRank([1, 2, 3, 4], 4)).toBe(87.5)
    expect(slope([[0, 0], [10, 5], [20, 10]])).toBeCloseTo(0.5)
  })
})

describe('computeFeatures', () => {
  const series = [obs(10, 8), obs(25, 14), obs(40, 21), obs(55, 28)]

  it('measures level, rise per 15 miles and consecutive elevated readings', () => {
    const f = computeFeatures(series, opts)
    expect(f.observations).toBe(4)
    expect(f.sideDelta).toBe(28)
    expect(f.risePer15mi).toBeCloseTo(6.7, 1)
    expect(f.consecutiveElevated).toBe(2)
    expect(f.coverageGap).toBe(false)
  })

  it('gives the same answer whatever order the passes arrived in (late, out-of-order data)', () => {
    const inOrder = computeFeatures(series, opts)
    const shuffled = computeFeatures([series[2], series[0], series[3], series[1]], opts)
    expect(shuffled).toEqual(inOrder)
  })

  it('computes rise per mile across a silent detector instead of assuming 15-mile steps', () => {
    // 55 -> 85 skips a silent detector at 70: a 30-mile gap.
    const gapped = [obs(25, 10), obs(40, 16), obs(55, 22), obs(85, 34)]
    const f = computeFeatures(gapped, opts)
    expect(f.coverageGap).toBe(true)
    expect(f.maxGapMiles).toBe(30)
    expect(f.risePer15mi).toBeCloseTo(6, 0)
  })

  it('picks up an edge alarm on any observation and bias correction on the latest', () => {
    const f = computeFeatures([obs(10, 5), obs(25, 9, { edgeAlarm: true, biasCorrected: true })], opts)
    expect(f.edgeAlarm).toBe(true)
    expect(f.biasCorrected).toBe(true)
    expect(f.risePer15mi).toBeNull() // fewer than 3 observations
  })
})

describe('buildObservations', () => {
  it('normalizes against the median of the same rail in the same pass and corrects known detector bias', () => {
    const ctx: PassContext = { detectorId: 'HBD-140', passId: 'p1', milepost: 140, passedAtMs: 0, ambientF: 60, biasOffsetF: -20, lagSeconds: 0, edgeAlarmKeys: new Set() }
    const rows: ReadingRow[] = []
    // Ten cars' axle-1 bearings on each rail; the south rail reads 6°F warmer (sun) for everyone.
    for (let i = 0; i < 10; i++) {
      rows.push({ detectorId: 'HBD-140', passId: 'p1', axleSeq: i * 4 + 1, rail: 'N', bearingF: 100, wheelF: 70, carId: `C${i}`, carSide: 'R', carAxle: 1 })
      rows.push({ detectorId: 'HBD-140', passId: 'p1', axleSeq: i * 4 + 1, rail: 'S', bearingF: i === 3 ? 146 : 106, wheelF: 70, carId: `C${i}`, carSide: 'L', carAxle: 1 })
    }
    const out = buildObservations(rows, new Map([['HBD-140|p1', ctx]]), 0)
    const hot = out.get('C3|L1')![0]
    expect(hot.sideDelta).toBe(40) // vs the south-rail median, so the sun on that side cancels
    expect(hot.rawAboveAmbient).toBe(86)
    expect(hot.aboveAmbient).toBe(106) // the detector reads 20°F low; corrected
    expect(out.get('C1|R1')![0].sideDelta).toBe(0)
  })
})
