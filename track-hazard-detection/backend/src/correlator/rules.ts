/**
 * Correlation rules: pure functions, no I/O.
 *
 * - Evidence is what a single edge event says about a possible hazard, with a
 *   confidence. Readings that say nothing (a quiet geophone, a "clear" camera
 *   frame) produce no evidence.
 * - Evidence from different sensors combines with a noisy-OR: each sensor is an
 *   independent chance of being right, so two 0.45 sensors give 0.70. The same
 *   sensor reporting twice counts once (its best report): a second wire on one
 *   fence, or a gateway resending, never inflates confidence.
 * - Confidence maps to severity: confirmed (>= 0.8) is CRITICAL, detected
 *   (>= 0.5) is HIGH, below that the hazard is unconfirmed.
 *
 * Every constant here is an illustrative assumption.
 * @module correlator/rules
 */
import { config } from '../shared/config.js'
import type { DetectionStatus, EvidenceKind, EvidenceRef, HazardKind, Severity } from '../shared/events/domain.js'

export interface Evidence {
  eventId: string
  kind: EvidenceKind
  sensorId: string
  subdivisionId: string
  segmentId: string
  milepost: number
  occurredAt: string
  confidence: number
  late: boolean
  explainedByTrain: string | null
  hazardId: string | null
  details: Record<string, unknown>
}

/** The correlator's view of an open hazard (its spatial index row). */
export interface HazardRecord {
  hazardId: string
  code: string
  kind: HazardKind
  subdivisionId: string
  segmentId: string
  mpFrom: number
  mpTo: number
  confidence: number
  severity: Severity
  detectionStatus: DetectionStatus
  firstEvidenceAt: string
  streamVersion: number
}

export interface CorrelationConfig {
  windowSeconds: number
  radiusMiles: number
  detectThreshold: number
  confirmThreshold: number
  vibrationSpikeMmS: number
  trainExplainMiles: number
  trainExtrapolateSeconds: number
}

export const defaultCorrelationConfig = (): CorrelationConfig => ({ ...config.correlation })

/** Which hazard kinds each evidence kind can support. Ground vibration supports either a rockfall or an obstruction. */
export const SUPPORTS: Record<EvidenceKind, HazardKind[]> = {
  fence_break: ['rockfall'],
  ground_vibration: ['rockfall', 'obstruction'],
  camera_obstruction: ['obstruction'],
  high_water: ['high_water'],
}

const CLASS_WEIGHT: Record<string, number> = { vehicle: 1, debris: 1, person: 0.9, animal: 0.7 }

export const round3 = (n: number) => Math.round(n * 1000) / 1000

export function supports(hazard: HazardKind, evidence: EvidenceKind): boolean {
  return SUPPORTS[evidence].includes(hazard)
}

export function compatible(a: EvidenceKind, b: EvidenceKind): boolean {
  return SUPPORTS[a].some((k) => SUPPORTS[b].includes(k))
}

/** The most specific evidence names the hazard: a fence break is a rockfall even if a camera also fired. */
export function hazardKindFor(evidence: Pick<Evidence, 'kind'>[]): HazardKind | null {
  const kinds = new Set(evidence.map((e) => e.kind))
  if (kinds.has('fence_break')) return 'rockfall'
  if (kinds.has('camera_obstruction')) return 'obstruction'
  if (kinds.has('high_water')) return 'high_water'
  if (kinds.has('ground_vibration')) return 'rockfall'
  return null
}

/** Noisy-OR across sensors, best report per sensor, ignoring evidence a train explained. */
export function combinedConfidence(evidence: Pick<Evidence, 'sensorId' | 'confidence' | 'explainedByTrain'>[]): number {
  const perSensor = new Map<string, number>()
  for (const e of evidence) {
    if (e.explainedByTrain) continue
    perSensor.set(e.sensorId, Math.max(perSensor.get(e.sensorId) ?? 0, e.confidence))
  }
  let miss = 1
  for (const c of perSensor.values()) miss *= 1 - c
  return round3(1 - miss)
}

export function classify(confidence: number, cfg: Pick<CorrelationConfig, 'detectThreshold' | 'confirmThreshold'>): { severity: Severity; detectionStatus: DetectionStatus } {
  if (confidence >= cfg.confirmThreshold) return { severity: 'CRITICAL', detectionStatus: 'confirmed' }
  if (confidence >= cfg.detectThreshold) return { severity: 'HIGH', detectionStatus: 'detected' }
  return { severity: 'LOW', detectionStatus: 'unconfirmed' }
}

const STATUS_RANK: Record<string, number> = { unconfirmed: 0, detected: 1, confirmed: 2 }
export const statusRank = (s: DetectionStatus) => STATUS_RANK[s] ?? 0

export interface EdgeFacts {
  type: string
  payload: Record<string, unknown>
}

/** What one edge event says about a hazard, or null when it says nothing. */
export function evidenceFromEdge(facts: EdgeFacts, cfg: Pick<CorrelationConfig, 'vibrationSpikeMmS'>): { kind: EvidenceKind; confidence: number; details: Record<string, unknown> } | null {
  const p = facts.payload
  switch (facts.type) {
    case 'SensorReadingReported': {
      if (p.kind !== 'vibration' || typeof p.peakMmS !== 'number' || p.peakMmS < cfg.vibrationSpikeMmS) return null
      // A spike alone is weak evidence (trains, wind, maintenance crews); a big one a little less weak.
      const confidence = Math.min(0.5, 0.35 + (p.peakMmS - cfg.vibrationSpikeMmS) / 200)
      return { kind: 'ground_vibration', confidence: round3(confidence), details: { peakMmS: p.peakMmS, rmsMmS: p.rmsMmS ?? null } }
    }
    case 'CameraDetectionReported': {
      const cls = String(p.detectionClass)
      if (cls === 'clear' || !(cls in CLASS_WEIGHT)) return null
      const confidence = Number(p.confidence) * CLASS_WEIGHT[cls]
      return { kind: 'camera_obstruction', confidence: round3(confidence), details: { detectionClass: cls, modelConfidence: p.confidence, imageRef: p.imageRef, bbox: p.bbox ?? null, modelVersion: p.modelVersion ?? null } }
    }
    case 'SlideFenceTripped':
      return { kind: 'fence_break', confidence: 0.85, details: { wire: p.wire, interlockSignalDropped: p.interlockSignalDropped, signalId: p.signalId } }
    case 'WaterLevelReported': {
      const inches = Number(p.inchesBelowRail)
      if (!(inches <= 24)) return null
      return { kind: 'high_water', confidence: inches <= 6 ? 0.9 : 0.6, details: { inchesBelowRail: inches, risingInPerHr: p.risingInPerHr } }
    }
    default:
      return null
  }
}

export function toRef(e: Evidence): EvidenceRef {
  return { eventId: e.eventId, sensorId: e.sensorId, kind: e.kind, milepost: e.milepost, occurredAt: e.occurredAt, confidence: e.confidence, late: e.late }
}

const ms = (iso: string) => Date.parse(iso)

/** Is `e` inside the space-time window of `anchor`? */
export function inWindow(anchor: Pick<Evidence, 'milepost' | 'occurredAt'>, e: Pick<Evidence, 'milepost' | 'occurredAt'>, cfg: Pick<CorrelationConfig, 'windowSeconds' | 'radiusMiles'>): boolean {
  return Math.abs(anchor.milepost - e.milepost) <= cfg.radiusMiles + 1e-9 && Math.abs(ms(anchor.occurredAt) - ms(e.occurredAt)) <= cfg.windowSeconds * 1000
}

/** Can new evidence join an open hazard? Same family, within the radius of its span, not much older than the hazard. */
export function canAttach(h: HazardRecord, e: Evidence, cfg: Pick<CorrelationConfig, 'windowSeconds' | 'radiusMiles'>): boolean {
  if (!supports(h.kind, e.kind)) return false
  if (e.milepost < h.mpFrom - cfg.radiusMiles - 1e-9 || e.milepost > h.mpTo + cfg.radiusMiles + 1e-9) return false
  return ms(e.occurredAt) >= ms(h.firstEvidenceAt) - cfg.windowSeconds * 1000
}

export function distanceToSpan(h: Pick<HazardRecord, 'mpFrom' | 'mpTo'>, mp: number): number {
  if (mp < h.mpFrom) return h.mpFrom - mp
  if (mp > h.mpTo) return mp - h.mpTo
  return 0
}

export interface TrainFix {
  trainId: string
  symbol: string
  milepost: number
  direction: 'increasing' | 'decreasing'
  speedMph: number
  occurredAt: string
}

/**
 * Where was a train at time t? Interpolates between two fixes that bracket t,
 * or extrapolates from the nearest fix at its reported speed when that fix is
 * within `extrapolateSeconds`. Null when the train's position is unknown.
 */
export function trainMilepostAt(before: TrainFix | null, after: TrainFix | null, atIso: string, extrapolateSeconds: number): number | null {
  const t = ms(atIso)
  if (before && after) {
    const t0 = ms(before.occurredAt)
    const t1 = ms(after.occurredAt)
    if (t1 - t0 <= 120_000) {
      if (t1 === t0) return before.milepost
      return before.milepost + ((after.milepost - before.milepost) * (t - t0)) / (t1 - t0)
    }
  }
  const fix = [before, after].filter((f): f is TrainFix => f !== null).sort((a, b) => Math.abs(ms(a.occurredAt) - t) - Math.abs(ms(b.occurredAt) - t))[0]
  if (!fix) return null
  const dtSec = (t - ms(fix.occurredAt)) / 1000
  if (Math.abs(dtSec) > extrapolateSeconds) return null
  const sign = fix.direction === 'increasing' ? 1 : -1
  return fix.milepost + (sign * fix.speedMph * dtSec) / 3600
}
