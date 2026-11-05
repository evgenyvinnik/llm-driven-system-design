/**
 * Risk scoring: explainable rules over trend features. A dispatcher deciding
 * whether to stop a two-mile train needs to see why, so every tier comes with
 * the reasons that produced it. Thresholds are configurable and illustrative.
 * @module analyzer/risk
 */
import { TIER, TIER_NAMES, type Thresholds, type Tier } from '../shared/domain.js'
import { computeFeatures, type BearingFeatures, type FeatureOptions, type Observation } from './trend.js'

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
  // Lead with what set the tier, then the strongest supporting evidence, without repeating the same reading.
  const ordered = [...matched.filter((c) => c.tier === tier), ...matched.filter((c) => c.tier !== tier)]
  const seen = new Set<string>()
  const reasons = ordered
    .map((c) => c.reason)
    .filter((r) => {
      const key = r.split(' (')[0].split(',')[0]
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 3)
  return { tier, reasons: [...reasons, ...context(f)] }
}

/** Hot wheels point at a stuck or dragging brake, not a bearing. */
export function scoreHotWheel(f: BearingFeatures, t: Thresholds): Score {
  if (f.wheelConsecutiveHot < 2) return { tier: TIER.NONE, reasons: [] }
  const text = `Wheel ${signed(f.wheelDelta)}°F vs train-side median at ${f.wheelConsecutiveHot} consecutive detectors (likely stuck brake)`
  if (f.wheelDelta >= t.hotWheelHighDelta) return { tier: TIER.HIGH, reasons: [text] }
  if (f.wheelDelta >= t.hotWheelDelta) return { tier: TIER.MEDIUM, reasons: [text] }
  return { tier: TIER.NONE, reasons: [] }
}

/**
 * Cold wheels point at an inoperative brake: where every other car is braking
 * (a braking zone), this wheel stays near ambient. Only braking-zone readings count.
 */
export function scoreColdWheel(f: BearingFeatures, t: Thresholds): Score {
  if (f.brakingZoneReadings >= 2 && f.coldWheelReadings === f.brakingZoneReadings) {
    return { tier: TIER.MEDIUM, reasons: [`Wheel ${t.coldWheelDelta}°F+ colder than the train-side median in ${f.coldWheelReadings} braking zones (likely inoperative brake)`] }
  }
  return { tier: TIER.NONE, reasons: [] }
}

export const tierName = (tier: number) => TIER_NAMES[tier] ?? 'NONE'

/**
 * Scores a bearing as in-order processing would have: the tier is the maximum
 * over every event-time prefix of its observations, because an alert, once
 * opened, never de-escalates. Scoring only the latest observation would make
 * the decision depend on arrival order: an old hot reading that arrives after a
 * newer normal one would be ignored, though on time it would have opened an
 * alert. Returns the winning score, the features that produced it (peak) and
 * the latest features (for display).
 */
export function scoreOverHistory(
  observations: Observation[],
  opts: FeatureOptions,
  t: Thresholds,
  scorer: (f: BearingFeatures, t: Thresholds) => Score,
): { score: Score; peak: BearingFeatures; latest: BearingFeatures } {
  const sorted = [...observations].sort((a, b) => a.distance - b.distance || a.passedAtMs - b.passedAtMs)
  const latest = computeFeatures(sorted, opts)
  let best: { score: Score; features: BearingFeatures } = { score: scorer(latest, t), features: latest }
  for (let k = 1; k < sorted.length; k++) {
    const f = computeFeatures(sorted.slice(0, k), opts)
    const s = scorer(f, t)
    if (s.tier > best.score.tier) best = { score: s, features: f }
  }
  if (best.features !== latest && best.score.tier > TIER.NONE) {
    const note = `Latest reading at ${latest.lastDetectorId}: ${signed(latest.sideDelta)}°F vs train-side median`
    best = { ...best, score: { tier: best.score.tier, reasons: [...best.score.reasons, note] } }
  }
  return { score: best.score, peak: best.features, latest }
}
