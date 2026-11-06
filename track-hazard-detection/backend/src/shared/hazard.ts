/**
 * The hazard aggregate: a pure fold over a hazard stream's events.
 *
 * The same reducer is used three ways, which is what makes replay trustworthy:
 * - the alerting process manager folds the stream to decide what to do next;
 * - API commands fold it to check business rules before appending;
 * - the `hazards` projection stores the folded state as its read model.
 * Everything in the state is derived from event data (never from "now"), so
 * folding the same events always gives the same state.
 * @module shared/hazard
 */
import type { Envelope } from './events/envelope.js'
import type { DetectionStatus, DomainPayload, EvidenceRef, HazardKind, Severity, WarnedTrain } from './events/domain.js'

export type ResponseStatus = 'alerting' | 'acknowledged' | 'responding' | 'cleared' | 'false_alarm'

export interface RestrictionState {
  restrictionId: string
  mpFrom: number
  mpTo: number
  maxSpeedMph: number
  reason: string
  automatic: boolean
  issuedBy: string
  issuedAt: string
  liftedAt: string | null
  liftedBy: string | null
}

export interface HazardState {
  hazardId: string
  code: string
  kind: HazardKind
  subdivisionId: string
  segmentId: string
  mpFrom: number
  mpTo: number
  confidence: number
  severity: Severity
  /** The highest severity this hazard ever reached; alerts are never relaxed automatically. */
  peakSeverity: Severity
  detectionStatus: DetectionStatus
  late: boolean
  open: boolean
  evidence: EvidenceRef[]
  firstEvidenceAt: string
  detectedAt: string
  trigger: { eventId: string; occurredAt: string; recordedAt: string; lane: string; late: boolean }
  heat: { band: string; railTempF: number; neutralTempF: number; projectedTempF: number } | null
  alert: {
    alertId: string
    /** Severity the alert was last issued or re-issued at. */
    severity: Severity
    issuedAt: string
    deskId: string
    assignee: string | null
    ackDeadlineAt: string
    escalationLevel: number
    escalationTarget: string | null
    acknowledgedAt: string | null
    acknowledgedBy: string | null
  } | null
  warnedTrains: Array<WarnedTrain & { warnedAt: string; automatic: boolean; releasedAt: string | null }>
  restrictions: RestrictionState[]
  inspector: { username: string; name: string; dispatchedAt: string; etaMinutes: number } | null
  responseStatus: ResponseStatus
  closedAt: string | null
  closedBy: string | null
  closeNote: string | null
  version: number
  lastEventAt: string
}

const SEV_ORDER: Severity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
const maxSeverity = (a: Severity, b: Severity): Severity => (SEV_ORDER.indexOf(a) >= SEV_ORDER.indexOf(b) ? a : b)

function responseStatusOf(s: HazardState): ResponseStatus {
  if (!s.open) return s.responseStatus
  if (s.restrictions.some((r) => !r.liftedAt) || s.warnedTrains.some((t) => !t.releasedAt && !t.automatic) || s.inspector) {
    return s.alert?.acknowledgedAt ? 'responding' : 'alerting'
  }
  return s.alert?.acknowledgedAt ? 'acknowledged' : 'alerting'
}

/** Applies one event. Returns the previous state unchanged for events that don't concern hazards. */
export function reduceHazard(state: HazardState | null, env: Envelope): HazardState | null {
  const at = env.occurredAt
  const p = env.payload as Record<string, unknown>
  let s: HazardState | null = state ? { ...state } : null

  switch (env.type) {
    case 'HazardDetected': {
      const d = p as unknown as DomainPayload<'HazardDetected'>
      s = {
        hazardId: d.hazardId,
        code: d.code,
        kind: d.kind,
        subdivisionId: d.subdivisionId,
        segmentId: d.segmentId,
        mpFrom: d.mpFrom,
        mpTo: d.mpTo,
        confidence: d.confidence,
        severity: d.severity,
        peakSeverity: d.severity,
        detectionStatus: d.detectionStatus,
        late: d.late,
        open: true,
        evidence: d.evidence,
        firstEvidenceAt: d.evidence.map((e) => e.occurredAt).sort()[0] ?? d.trigger.occurredAt,
        detectedAt: env.recordedAt,
        trigger: d.trigger,
        heat: null,
        alert: null,
        warnedTrains: [],
        restrictions: [],
        inspector: null,
        responseStatus: 'alerting',
        closedAt: null,
        closedBy: null,
        closeNote: null,
        version: 0,
        lastEventAt: at,
      }
      break
    }
    case 'HazardRiskElevated': {
      const d = p as unknown as DomainPayload<'HazardRiskElevated'>
      const heat = { band: d.band, railTempF: d.railTempF, neutralTempF: d.neutralTempF, projectedTempF: d.projectedTempF }
      if (s) {
        s.severity = maxSeverity(s.severity, d.severity)
        s.peakSeverity = maxSeverity(s.peakSeverity, d.severity)
        s.heat = heat
        s.detectionStatus = 'risk_elevated'
      } else {
        s = {
          hazardId: d.hazardId,
          code: d.code,
          kind: 'rail_buckling_risk',
          subdivisionId: d.subdivisionId,
          segmentId: d.segmentId,
          mpFrom: d.mpFrom,
          mpTo: d.mpTo,
          confidence: 1,
          severity: d.severity,
          peakSeverity: d.severity,
          detectionStatus: 'risk_elevated',
          late: d.trigger.late,
          open: true,
          evidence: [],
          firstEvidenceAt: d.trigger.occurredAt,
          detectedAt: env.recordedAt,
          trigger: d.trigger,
          heat,
          alert: null,
          warnedTrains: [],
          restrictions: [],
          inspector: null,
          responseStatus: 'alerting',
          closedAt: null,
          closedBy: null,
          closeNote: null,
          version: 0,
          lastEventAt: at,
        }
      }
      break
    }
    default:
      if (!s) return null
  }
  if (!s) return null

  switch (env.type) {
    case 'HazardEvidenceAdded': {
      const d = p as unknown as DomainPayload<'HazardEvidenceAdded'>
      if (!s.evidence.some((e) => e.eventId === d.evidence.eventId)) s.evidence = [...s.evidence, d.evidence]
      s.confidence = d.confidence
      s.mpFrom = d.mpFrom
      s.mpTo = d.mpTo
      if (d.evidence.occurredAt < s.firstEvidenceAt) s.firstEvidenceAt = d.evidence.occurredAt
      break
    }
    case 'HazardUpgraded':
    case 'HazardDowngraded': {
      const d = p as unknown as DomainPayload<'HazardUpgraded'> & { removedEvidence?: string[] }
      s.severity = d.toSeverity
      s.peakSeverity = maxSeverity(s.peakSeverity, d.toSeverity)
      s.detectionStatus = d.toStatus
      s.confidence = d.confidence
      if (d.removedEvidence?.length) s.evidence = s.evidence.filter((e) => !d.removedEvidence!.includes(e.eventId))
      break
    }
    case 'HazardRiskSubsided': {
      const d = p as unknown as DomainPayload<'HazardRiskSubsided'>
      s.detectionStatus = 'risk_subsided'
      if (s.heat) s.heat = { ...s.heat, railTempF: d.railTempF, projectedTempF: d.projectedTempF, band: 'subsided' }
      break
    }
    case 'AlertIssued': {
      const d = p as unknown as DomainPayload<'AlertIssued'>
      s.alert = {
        alertId: d.alertId,
        severity: d.severity,
        issuedAt: env.recordedAt,
        deskId: d.deskId,
        assignee: d.assignee,
        ackDeadlineAt: d.ackDeadlineAt,
        escalationLevel: 0,
        escalationTarget: d.assignee,
        acknowledgedAt: null,
        acknowledgedBy: null,
      }
      break
    }
    case 'AlertEscalated': {
      const d = p as unknown as DomainPayload<'AlertEscalated'>
      if (s.alert) {
        s.alert = { ...s.alert, escalationLevel: d.level, escalationTarget: d.target, ackDeadlineAt: d.ackDeadlineAt, severity: d.severity }
        // A hazard that got worse needs a fresh acknowledgment of the worse situation.
        if (d.reason === 'severity_raised') s.alert = { ...s.alert, acknowledgedAt: null, acknowledgedBy: null }
      }
      break
    }
    case 'AlertAcknowledged': {
      const d = p as unknown as DomainPayload<'AlertAcknowledged'>
      if (s.alert && !s.alert.acknowledgedAt) s.alert = { ...s.alert, acknowledgedAt: at, acknowledgedBy: d.by }
      break
    }
    case 'TrainsWarned': {
      const d = p as unknown as DomainPayload<'TrainsWarned'>
      const known = new Set(s.warnedTrains.filter((t) => !t.releasedAt).map((t) => t.trainId))
      s.warnedTrains = [...s.warnedTrains, ...d.trains.filter((t) => !known.has(t.trainId)).map((t) => ({ ...t, warnedAt: at, automatic: d.automatic, releasedAt: null }))]
      break
    }
    case 'TrainsReleased': {
      const d = p as unknown as DomainPayload<'TrainsReleased'>
      s.warnedTrains = s.warnedTrains.map((t) => (d.trainIds.includes(t.trainId) && !t.releasedAt ? { ...t, releasedAt: at } : t))
      break
    }
    case 'SpeedRestrictionIssued': {
      const d = p as unknown as DomainPayload<'SpeedRestrictionIssued'>
      if (!s.restrictions.some((r) => r.restrictionId === d.restrictionId)) {
        s.restrictions = [
          ...s.restrictions,
          { restrictionId: d.restrictionId, mpFrom: d.mpFrom, mpTo: d.mpTo, maxSpeedMph: d.maxSpeedMph, reason: d.reason, automatic: d.automatic, issuedBy: d.by, issuedAt: at, liftedAt: null, liftedBy: null },
        ]
      }
      break
    }
    case 'SpeedRestrictionLifted': {
      const d = p as unknown as DomainPayload<'SpeedRestrictionLifted'>
      s.restrictions = s.restrictions.map((r) => (r.restrictionId === d.restrictionId && !r.liftedAt ? { ...r, liftedAt: at, liftedBy: d.by } : r))
      break
    }
    case 'InspectorDispatched': {
      const d = p as unknown as DomainPayload<'InspectorDispatched'>
      s.inspector = { username: d.inspector, name: d.inspectorName, dispatchedAt: at, etaMinutes: d.etaMinutes }
      break
    }
    case 'HazardCleared':
    case 'HazardConfirmedFalseAlarm': {
      const d = p as unknown as DomainPayload<'HazardCleared'>
      s.open = false
      s.responseStatus = env.type === 'HazardCleared' ? 'cleared' : 'false_alarm'
      s.closedAt = at
      s.closedBy = d.by
      s.closeNote = d.note ?? null
      break
    }
  }
  s.version = env.streamVersion
  if (at > s.lastEventAt) s.lastEventAt = at
  s.responseStatus = responseStatusOf(s)
  return s
}

export function foldHazard(events: Envelope[]): HazardState | null {
  return events.reduce<HazardState | null>((s, e) => reduceHazard(s, e), null)
}

export const activeRestrictions = (s: HazardState) => s.restrictions.filter((r) => !r.liftedAt)
export const activeWarnings = (s: HazardState) => s.warnedTrains.filter((t) => !t.releasedAt)
