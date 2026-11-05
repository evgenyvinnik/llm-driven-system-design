/**
 * Domain vocabulary shared by the API, the analyzer and the simulator.
 * @module shared/domain
 */

export type Direction = 'EB' | 'WB'
/** Which rail a detector scanner sits on. The line runs east-west. */
export type Rail = 'N' | 'S'
/** Car-relative side: standing at the B-end facing the A-end. */
export type CarSide = 'L' | 'R'
export type CarEnd = 'A' | 'B'
/**
 * Two different failure modes, kept apart everywhere:
 *  - hot_bearing: a journal bearing failing (bearing temperature, trended across detectors).
 *  - hot_wheel / cold_wheel: brakes. A stuck or dragging brake heats the wheel tread; an
 *    inoperative brake leaves its wheels cold where every other car is braking.
 */
export type AlertKind = 'hot_bearing' | 'hot_wheel' | 'cold_wheel'
export const isBrakeKind = (kind: string) => kind === 'hot_wheel' || kind === 'cold_wheel'

/** 0 = no alert. Stored as a smallint so escalation is a numeric comparison. */
export const TIER = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 } as const
export type Tier = (typeof TIER)[keyof typeof TIER]
export const TIER_NAMES: Record<number, string> = { 0: 'NONE', 1: 'LOW', 2: 'MEDIUM', 3: 'HIGH', 4: 'CRITICAL' }

export const TIER_ACTION: Record<number, string> = {
  1: 'monitor_notify_owner',
  2: 'inspect_next_terminal',
  3: 'setout_or_restricted_speed',
  4: 'stop_and_inspect',
}

const BRAKE_ACTION: Record<number, string> = {
  1: 'monitor_notify_owner',
  2: 'brake_inspection_next_terminal',
  3: 'brake_inspection_setout',
  4: 'stop_and_inspect',
}

/** Bearing alerts lead to a journal bearing inspection; wheel alerts to a brake inspection. */
export function actionFor(kind: string, tier: number): string {
  return (isBrakeKind(kind) ? BRAKE_ACTION : TIER_ACTION)[tier] ?? 'monitor_notify_owner'
}

/**
 * Minutes the owner has to acknowledge before the alert escalates to the next role.
 * Illustrative values in domain (simulated) time. LOW needs no acknowledgment.
 */
export const ACK_DEADLINE_MINUTES: Record<number, number | null> = { 1: null, 2: 60, 3: 15, 4: 5 }

/** Escalation chains, by the role that owns the alert. Level 0 is the primary owner. */
export const ESCALATION_CHAIN: Record<'dispatcher' | 'yard', string[]> = {
  dispatcher: ['dispatcher desk', 'chief dispatcher', 'network operations center'],
  yard: ['yard car inspectors', 'yard general foreman', 'network operations center'],
}

export const FINDINGS = ['confirmed_bearing_defect', 'brake_defect', 'wheel_defect', 'no_defect_found'] as const
export type Finding = (typeof FINDINGS)[number]
/** repaired = defect confirmed and the wheelset replaced on the spot; the car returns to service. */
export const DISPOSITIONS = ['bad_order', 'release', 'repaired'] as const
export type Disposition = (typeof DISPOSITIONS)[number]

/**
 * Alerting thresholds. Every number here is an ILLUSTRATIVE default for the
 * simulation, editable on the admin page. None of them is a regulatory or
 * industry value; real railroads tune their own per detector type and route.
 */
export interface Thresholds {
  /** Mirrors the detector's own absolute alarm (°F above ambient). */
  criticalAboveAmbient: number
  highAboveAmbient: number
  /** HIGH by trend: this far above the train-side median AND rising this fast. */
  highSideDelta: number
  highRisePer15mi: number
  /** MEDIUM by level: this far above the train-side median at 2+ consecutive detectors. */
  mediumSideDelta: number
  /** MEDIUM by a single large outlier (sudden onset). */
  mediumOutlierSideDelta: number
  /** MEDIUM by trend: rising this fast over 4+ observations, at least mediumRiseMinSideDelta above median. */
  mediumRisePer15mi: number
  mediumRiseMinSideDelta: number
  /** "Elevated": at least this far above the train-side median. LOW = elevated at 2+ consecutive detectors. */
  elevatedSideDelta: number
  /** LOW by history: elevated on this many of the car's previous trips. */
  lowHistoryTrips: number
  lowHistoryMinSideDelta: number
  /** Wheel tread temperature above the train-side median (stuck or dragging brake). */
  hotWheelDelta: number
  hotWheelHighDelta: number
  /** Wheel this far BELOW the train-side median in a braking zone (inoperative brake). */
  coldWheelDelta: number
  /** Gaps between observations wider than this are flagged as coverage gaps. */
  maxDetectorSpacingMiles: number
  /** A detector reading this far from its neighbours (same trains) is flagged biased. */
  biasAlarmF: number
  biasMinSamples: number
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  criticalAboveAmbient: 195,
  highAboveAmbient: 150,
  highSideDelta: 60,
  highRisePer15mi: 8,
  mediumSideDelta: 35,
  mediumOutlierSideDelta: 45,
  mediumRisePer15mi: 6,
  mediumRiseMinSideDelta: 25,
  elevatedSideDelta: 20,
  lowHistoryTrips: 2,
  lowHistoryMinSideDelta: 15,
  hotWheelDelta: 150,
  hotWheelHighDelta: 250,
  coldWheelDelta: 50,
  maxDetectorSpacingMiles: 20,
  biasAlarmF: 12,
  biasMinSamples: 3,
}

/** Bearing/wheel position label in car-relative terms, e.g. "R1" = right side, axle 1 (B-end). */
export function positionLabel(side: CarSide, axle: number): string {
  return `${side}${axle}`
}
