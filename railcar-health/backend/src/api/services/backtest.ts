/**
 * Threshold backtest: re-score the features stored on closed, inspected alerts
 * under proposed thresholds, and compare alert volume and precision with the
 * current ones. Inspection findings are the labels.
 * @module api/services/backtest
 */
import { scoreBearing, scoreWheel } from '../../analyzer/risk.js'
import type { BearingFeatures } from '../../analyzer/trend.js'
import { TIER, TIER_NAMES, type Thresholds } from '../../shared/domain.js'

export interface LabeledAlert {
  kind: string
  tier: number
  features: Partial<BearingFeatures>
  defect: boolean
}

export interface TierStats {
  tier: string
  alerts: number
  defects: number
  precision: number | null
}

function toFeatures(f: Partial<BearingFeatures>): BearingFeatures {
  return {
    observations: f.observations ?? 1,
    aboveAmbient: f.aboveAmbient ?? 0,
    sideDelta: f.sideDelta ?? 0,
    maxSideDelta: f.maxSideDelta ?? f.sideDelta ?? 0,
    medianSideDelta: f.medianSideDelta ?? f.sideDelta ?? 0,
    risePer15mi: f.risePer15mi ?? null,
    consecutiveElevated: f.consecutiveElevated ?? 0,
    percentile: f.percentile ?? 50,
    maxGapMiles: f.maxGapMiles ?? 0,
    coverageGap: f.coverageGap ?? false,
    biasCorrected: f.biasCorrected ?? false,
    historyElevatedTrips: f.historyElevatedTrips ?? 0,
    wheelDelta: f.wheelDelta ?? 0,
    wheelConsecutiveHot: f.wheelConsecutiveHot ?? 0,
    edgeAlarm: f.edgeAlarm ?? false,
    lastDetectorId: f.lastDetectorId ?? '',
    lastPassId: '',
    lastPassedAtMs: 0,
    lastLagSeconds: 0,
    lastMilepost: f.lastMilepost ?? 0,
  }
}

export function rescore(alert: LabeledAlert, t: Thresholds): number {
  const f = toFeatures(alert.features)
  return alert.kind === 'hot_wheel' ? scoreWheel(f, t).tier : scoreBearing(f, t).tier
}

function stats(rows: Array<{ tier: number; defect: boolean }>): TierStats[] {
  return [TIER.CRITICAL, TIER.HIGH, TIER.MEDIUM, TIER.LOW].map((tier) => {
    const inTier = rows.filter((r) => r.tier === tier)
    const defects = inTier.filter((r) => r.defect).length
    return { tier: TIER_NAMES[tier], alerts: inTier.length, defects, precision: inTier.length ? defects / inTier.length : null }
  })
}

export function backtest(labeled: LabeledAlert[], current: Thresholds, proposed: Thresholds) {
  const now = labeled.map((a) => ({ tier: rescore(a, current), defect: a.defect }))
  const next = labeled.map((a) => ({ tier: rescore(a, proposed), defect: a.defect }))
  const actionable = (rows: typeof now) => rows.filter((r) => r.tier >= TIER.MEDIUM)
  const missedDefects = labeled.filter((a, i) => a.defect && now[i].tier >= TIER.MEDIUM && next[i].tier < TIER.MEDIUM).length
  const newlyCaught = labeled.filter((a, i) => a.defect && now[i].tier < TIER.MEDIUM && next[i].tier >= TIER.MEDIUM).length
  return {
    sample: labeled.length,
    current: { byTier: stats(now), actionable: actionable(now).length, actionableDefects: actionable(now).filter((r) => r.defect).length },
    proposed: { byTier: stats(next), actionable: actionable(next).length, actionableDefects: actionable(next).filter((r) => r.defect).length },
    missedDefects,
    newlyCaught,
  }
}
