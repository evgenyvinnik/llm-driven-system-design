import { describe, expect, it } from 'vitest'
import { DEFAULT_THRESHOLDS as T, TIER } from '../shared/domain.js'
import { scoreBearing, scoreColdWheel, scoreHotWheel, scoreOverHistory } from './risk.js'
import type { Observation } from './trend.js'
import type { BearingFeatures } from './trend.js'

function features(o: Partial<BearingFeatures>): BearingFeatures {
  return {
    observations: 5, aboveAmbient: 45, sideDelta: 2, maxSideDelta: 2, medianSideDelta: 2, risePer15mi: 0, consecutiveElevated: 0, percentile: 60,
    maxGapMiles: 15, coverageGap: false, biasCorrected: false, historyElevatedTrips: 0, wheelDelta: 0, wheelConsecutiveHot: 0, brakingZoneReadings: 0, coldWheelReadings: 0, edgeAlarm: false,
    lastDetectorId: 'HBD-055', lastPassId: 'p', lastPassedAtMs: 0, lastLagSeconds: 0, lastMilepost: 55, ...o,
  }
}

describe('scoreBearing', () => {
  it('raises nothing for a normal bearing', () => {
    expect(scoreBearing(features({}), T)).toEqual({ tier: TIER.NONE, reasons: [] })
  })

  it('flags a steady rise at MEDIUM long before any absolute threshold (the trending case)', () => {
    const s = scoreBearing(features({ aboveAmbient: 75, sideDelta: 29, risePer15mi: 7, observations: 4 }), T)
    expect(s.tier).toBe(TIER.MEDIUM)
    expect(s.reasons[0]).toMatch(/Steady rise/)
  })

  it('escalates to HIGH on level plus rise, and to CRITICAL at the absolute reference', () => {
    expect(scoreBearing(features({ aboveAmbient: 110, sideDelta: 65, risePer15mi: 9 }), T).tier).toBe(TIER.HIGH)
    expect(scoreBearing(features({ aboveAmbient: 151 }), T).tier).toBe(TIER.HIGH)
    expect(scoreBearing(features({ aboveAmbient: 200 }), T).tier).toBe(TIER.CRITICAL)
  })

  it('mirrors the detector alarm as CRITICAL even when the analyzer reads it lower', () => {
    const s = scoreBearing(features({ edgeAlarm: true, aboveAmbient: 120 }), T)
    expect(s.tier).toBe(TIER.CRITICAL)
    expect(s.reasons[0]).toMatch(/radioed to the crew/)
  })

  it('treats a single large outlier as MEDIUM (sudden onset)', () => {
    expect(scoreBearing(features({ sideDelta: 52, observations: 1, risePer15mi: null }), T).tier).toBe(TIER.MEDIUM)
  })

  it('uses car history for LOW only when the bearing also runs warm now', () => {
    expect(scoreBearing(features({ medianSideDelta: 17, sideDelta: 17, historyElevatedTrips: 2 }), T).tier).toBe(TIER.LOW)
    expect(scoreBearing(features({ medianSideDelta: 4, sideDelta: 4, historyElevatedTrips: 3 }), T).tier).toBe(TIER.NONE)
  })

  it('annotates coverage gaps and bias corrections', () => {
    const s = scoreBearing(features({ sideDelta: 40, consecutiveElevated: 2, coverageGap: true, maxGapMiles: 30, biasCorrected: true }), T)
    expect(s.reasons.some((r) => r.includes('Coverage gap: 30 mi'))).toBe(true)
    expect(s.reasons.some((r) => r.includes('biased detector'))).toBe(true)
  })

  it('follows edited thresholds', () => {
    const f = features({ sideDelta: 29, risePer15mi: 7, observations: 4, consecutiveElevated: 2 })
    expect(scoreBearing(f, T).tier).toBe(TIER.MEDIUM)
    expect(scoreBearing(f, { ...T, mediumRisePer15mi: 8 }).tier).toBe(TIER.LOW)
  })
})

describe('brake (wheel) scoring, kept apart from bearings', () => {
  it('hot wheels need two consecutive hot readings; very hot is HIGH (stuck brake)', () => {
    expect(scoreHotWheel(features({ wheelDelta: 220, wheelConsecutiveHot: 1 }), T).tier).toBe(TIER.NONE)
    expect(scoreHotWheel(features({ wheelDelta: 220, wheelConsecutiveHot: 2 }), T).tier).toBe(TIER.MEDIUM)
    expect(scoreHotWheel(features({ wheelDelta: 260, wheelConsecutiveHot: 3 }), T).tier).toBe(TIER.HIGH)
  })

  it('cold wheels count only in braking zones, and must be cold in every one (inoperative brake)', () => {
    expect(scoreColdWheel(features({ brakingZoneReadings: 2, coldWheelReadings: 2 }), T).tier).toBe(TIER.MEDIUM)
    expect(scoreColdWheel(features({ brakingZoneReadings: 2, coldWheelReadings: 1 }), T).tier).toBe(TIER.NONE)
    expect(scoreColdWheel(features({ brakingZoneReadings: 1, coldWheelReadings: 1 }), T).tier).toBe(TIER.NONE)
  })

  it('a hot bearing does not raise a brake alert, and a stuck brake does not raise a bearing alert', () => {
    expect(scoreHotWheel(features({ sideDelta: 80, aboveAmbient: 160, risePer15mi: 10 }), T).tier).toBe(TIER.NONE)
    expect(scoreBearing(features({ wheelDelta: 230, wheelConsecutiveHot: 4 }), T).tier).toBe(TIER.NONE)
  })
})

describe('arrival-order independence of the decision', () => {
  const o = (distance: number, sideDelta: number): Observation => ({
    detectorId: `HBD-${distance}`, passId: `p${distance}`, milepost: distance, distance, passedAtMs: distance * 80_000, rawAboveAmbient: 40 + sideDelta,
    aboveAmbient: 40 + sideDelta, sideDelta, percentile: 99, wheelDelta: 0, lagSeconds: 0, edgeAlarm: false, biasCorrected: false, brakingZone: false,
  })
  const opts = { elevatedSideDelta: 20, hotWheelDelta: 150, coldWheelDelta: 50, maxSpacingMiles: 20, historyElevatedTrips: 0 }

  it('scores an old hot reading that arrives after a newer normal one exactly as if it had arrived on time', () => {
    // On time: the +56 reading at MP 10 opens MEDIUM, and an alert never de-escalates.
    const onTime = scoreOverHistory([o(10, 56)], opts, T, scoreBearing).score.tier
    // Late: the normal MP 25 reading was processed first; the MP 10 reading arrives 90 minutes later.
    const late = scoreOverHistory([o(25, 1), o(10, 56)], opts, T, scoreBearing)
    expect(onTime).toBe(TIER.MEDIUM)
    expect(late.score.tier).toBe(TIER.MEDIUM)
    expect(late.score.reasons.at(-1)).toMatch(/Latest reading at HBD-25/)
    expect(late.latest.sideDelta).toBe(1)
  })
})
