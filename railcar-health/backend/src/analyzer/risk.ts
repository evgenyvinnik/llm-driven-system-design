/**
 * Risk scoring: explainable rules over trend features. A dispatcher deciding
 * whether to stop a two-mile train needs to see why, so every tier comes with
 * the reasons that produced it. Thresholds are configurable and illustrative.
 * @module analyzer/risk
 */
import { TIER, TIER_NAMES, type Thresholds, type Tier } from '../shared/domain.js'
import type { BearingFeatures } from './trend.js'

export interface Score {
  tier: Tier
  reasons: string[]
}

const f0 = (n: number) => Math.round(n).toString()
const f1 = (n: number) => (Math.round(n * 10) / 10).toFixed(1)
const signed = (n: number) => `${n >= 0 ? '+' : ''}${f0(n)}`

function context(f: BearingFeatures): string[] {
  const notes: string[] = []
  if (f.percentile >= 99) notes.push(`Hottest ${f1(100 - f.percentile)}% of the train side`)
  if (f.coverageGap) notes.push(`Coverage gap: ${f0(f.maxGapMiles)} mi between readings (silent or offline detector)`)
  if (f.biasCorrected) notes.push(`Above-ambient corrected for a biased detector at ${f.lastDetectorId}`)
  return notes
}

export function scoreBearing(f: BearingFeatures, t: Thresholds): Score {
  const rise = f.risePer15mi
  const risingText = rise === null ? '' : `, rising ${f1(rise)}°F per 15 mi`
  const checks: Array<{ tier: Tier; when: boolean; reason: string }> = [
    { tier: TIER.CRITICAL, when: f.edgeAlarm, reason: `Detector's own alarm fired (already radioed to the crew)` },
    { tier: TIER.CRITICAL, when: f.aboveAmbient >= t.criticalAboveAmbient, reason: `${f0(f.aboveAmbient)}°F above ambient (critical at ${t.criticalAboveAmbient})` },
    { tier: TIER.HIGH, when: f.aboveAmbient >= t.highAboveAmbient, reason: `${f0(f.aboveAmbient)}°F above ambient (high at ${t.highAboveAmbient})` },
    {
      tier: TIER.HIGH,
      when: f.observations >= 3 && f.sideDelta >= t.highSideDelta && rise !== null && rise >= t.highRisePer15mi,
      reason: `${signed(f.sideDelta)}°F vs train-side median${risingText} across ${f.observations} readings`,
    },
    {
      tier: TIER.MEDIUM,
      when: f.sideDelta >= t.mediumSideDelta && f.consecutiveElevated >= 2,
      reason: `${signed(f.sideDelta)}°F vs train-side median, elevated at ${f.consecutiveElevated} consecutive detectors`,
    },
    {
      tier: TIER.MEDIUM,
      when: f.sideDelta >= t.mediumOutlierSideDelta,
      reason: `${signed(f.sideDelta)}°F vs train-side median at ${f.lastDetectorId} (sudden outlier)`,
    },
    {
      tier: TIER.MEDIUM,
      when: f.observations >= 4 && rise !== null && rise >= t.mediumRisePer15mi && f.sideDelta >= t.mediumRiseMinSideDelta,
      reason: `Steady rise: ${signed(f.sideDelta)}°F vs train-side median${risingText} over ${f.observations} readings`,
    },
    {
      tier: TIER.LOW,
      when: f.sideDelta >= t.elevatedSideDelta && f.consecutiveElevated >= 2,
      reason: `${signed(f.sideDelta)}°F vs train-side median at ${f.consecutiveElevated} consecutive detectors`,
    },
    {
      tier: TIER.LOW,
      when: f.historyElevatedTrips >= t.lowHistoryTrips && f.observations >= 2 && f.medianSideDelta >= t.lowHistoryMinSideDelta,
      reason: `Runs warm on this trip (median ${signed(f.medianSideDelta)}°F) and was elevated on ${f.historyElevatedTrips} recent trips`,
    },
  ]
  const matched = checks.filter((c) => c.when)
  if (matched.length === 0) return { tier: TIER.NONE, reasons: [] }
  const tier = Math.max(...matched.map((c) => c.tier)) as Tier
  return { tier, reasons: [...matched.map((c) => c.reason), ...context(f)] }
}

/** Hot wheels point at a stuck or dragging brake rather than a bearing. */
export function scoreWheel(f: BearingFeatures, t: Thresholds): Score {
  if (f.wheelConsecutiveHot < 2) return { tier: TIER.NONE, reasons: [] }
  const text = `Wheel ${signed(f.wheelDelta)}°F vs train-side median at ${f.wheelConsecutiveHot} consecutive detectors (likely stuck brake)`
  if (f.wheelDelta >= t.hotWheelHighDelta) return { tier: TIER.HIGH, reasons: [text] }
  if (f.wheelDelta >= t.hotWheelDelta) return { tier: TIER.MEDIUM, reasons: [text] }
  return { tier: TIER.NONE, reasons: [] }
}

export const tierName = (tier: number) => TIER_NAMES[tier] ?? 'NONE'
