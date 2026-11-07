/**
 * Domain event schemas. Each hazard is an event-sourced aggregate whose stream
 * (`hazard-<uuid>`) holds its whole lifecycle: detection and evidence from the
 * correlator, alerting and train warnings from the process manager, and the
 * dispatcher's and inspector's commands from the API. Coverage events live on
 * `sensor-<id>` and `gateway-<id>` streams.
 *
 * All domain events are v1 today. A future change follows the same rule as
 * edge events: add an upcaster, never rewrite stored events.
 * @module shared/events/domain
 */
import { z } from 'zod'
import { PermanentError, type Envelope } from './envelope.js'

export const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
export type Severity = (typeof SEVERITIES)[number]
export const severityRank = (s: Severity) => SEVERITIES.indexOf(s)

export const HAZARD_KINDS = ['rockfall', 'obstruction', 'high_water', 'rail_buckling_risk'] as const
export type HazardKind = (typeof HAZARD_KINDS)[number]

export const EVIDENCE_KINDS = ['fence_break', 'ground_vibration', 'camera_obstruction', 'high_water'] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

export type DetectionStatus = 'detected' | 'confirmed' | 'unconfirmed' | 'risk_elevated' | 'risk_subsided'

const severity = z.enum(SEVERITIES)
const iso = z.string().datetime({ offset: true })

export const evidenceRef = z.object({
  eventId: z.string(),
  sensorId: z.string(),
  kind: z.enum(EVIDENCE_KINDS),
  milepost: z.number(),
  occurredAt: iso,
  confidence: z.number(),
  late: z.boolean(),
})
export type EvidenceRef = z.infer<typeof evidenceRef>

const trigger = z.object({ eventId: z.string(), occurredAt: iso, recordedAt: iso, lane: z.string(), late: z.boolean() })
const detectionStatus = z.enum(['detected', 'confirmed', 'unconfirmed', 'risk_elevated', 'risk_subsided'])

const train = z.object({
  trainId: z.string(),
  symbol: z.string(),
  etaMinutes: z.number(),
  distanceMiles: z.number(),
  direction: z.enum(['increasing', 'decreasing']),
})
export type WarnedTrain = z.infer<typeof train>

export const DOMAIN_SCHEMAS = {
  HazardDetected: z.object({
    hazardId: z.string(),
    code: z.string(),
    kind: z.enum(HAZARD_KINDS),
    subdivisionId: z.string(),
    segmentId: z.string(),
    mpFrom: z.number(),
    mpTo: z.number(),
    confidence: z.number(),
    severity,
    detectionStatus,
    evidence: z.array(evidenceRef),
    late: z.boolean(),
    trigger,
  }),
  HazardEvidenceAdded: z.object({ hazardId: z.string(), evidence: evidenceRef, confidence: z.number(), mpFrom: z.number(), mpTo: z.number() }),
  HazardUpgraded: z.object({
    hazardId: z.string(),
    fromSeverity: severity,
    toSeverity: severity,
    fromStatus: detectionStatus,
    toStatus: detectionStatus,
    confidence: z.number(),
    reason: z.string(),
    late: z.boolean(),
  }),
  HazardDowngraded: z.object({
    hazardId: z.string(),
    fromSeverity: severity,
    toSeverity: severity,
    fromStatus: detectionStatus,
    toStatus: detectionStatus,
    confidence: z.number(),
    reason: z.string(),
    removedEvidence: z.array(z.string()),
  }),
  HazardRiskElevated: z.object({
    hazardId: z.string(),
    code: z.string(),
    kind: z.literal('rail_buckling_risk'),
    subdivisionId: z.string(),
    segmentId: z.string(),
    mpFrom: z.number(),
    mpTo: z.number(),
    band: z.enum(['elevated', 'critical']),
    severity,
    sensorId: z.string(),
    railTempF: z.number(),
    neutralTempF: z.number(),
    projectedTempF: z.number(),
    slopeFPerMin: z.number(),
    trigger,
  }),
  HazardRiskSubsided: z.object({ hazardId: z.string(), railTempF: z.number(), projectedTempF: z.number() }),
  CoverageDegraded: z.object({
    scope: z.enum(['sensor', 'gateway']),
    targetId: z.string(),
    subdivisionId: z.string(),
    segmentId: z.string(),
    mpFrom: z.number(),
    mpTo: z.number(),
    reason: z.enum(['heartbeat_missed', 'gateway_silent']),
    since: iso,
  }),
  CoverageRestored: z.object({ scope: z.enum(['sensor', 'gateway']), targetId: z.string(), subdivisionId: z.string(), segmentId: z.string(), restoredAt: iso }),
  AlertIssued: z.object({
    hazardId: z.string(),
    alertId: z.string(),
    severity,
    deskId: z.string(),
    assignee: z.string().nullable(),
    ackDeadlineAt: iso,
    summary: z.string(),
    lane: z.string(),
    late: z.boolean(),
    timing: z.object({ edgeOccurredAt: iso, ingestedAt: iso, detectedAt: iso }),
  }),
  AlertEscalated: z.object({
    hazardId: z.string(),
    alertId: z.string(),
    level: z.number().int(),
    reason: z.enum(['ack_overdue', 'severity_raised']),
    target: z.string(),
    severity,
    ackDeadlineAt: iso,
  }),
  AlertAcknowledged: z.object({ hazardId: z.string(), alertId: z.string(), by: z.string(), note: z.string().optional() }),
  TrainsWarned: z.object({ hazardId: z.string(), trains: z.array(train), instruction: z.string(), automatic: z.boolean(), by: z.string() }),
  TrainsReleased: z.object({ hazardId: z.string(), trainIds: z.array(z.string()), reason: z.string(), by: z.string() }),
  SpeedRestrictionIssued: z.object({
    hazardId: z.string(),
    restrictionId: z.string(),
    subdivisionId: z.string(),
    mpFrom: z.number(),
    mpTo: z.number(),
    maxSpeedMph: z.number().int(),
    reason: z.string(),
    automatic: z.boolean(),
    by: z.string(),
  }),
  SpeedRestrictionLifted: z.object({ hazardId: z.string(), restrictionId: z.string(), reason: z.string(), by: z.string() }),
  InspectorDispatched: z.object({ hazardId: z.string(), inspector: z.string(), inspectorName: z.string(), etaMinutes: z.number(), by: z.string(), note: z.string().optional() }),
  HazardCleared: z.object({ hazardId: z.string(), by: z.string(), note: z.string().optional() }),
  HazardConfirmedFalseAlarm: z.object({ hazardId: z.string(), by: z.string(), note: z.string().optional(), cause: z.string().optional() }),
} as const

export type DomainType = keyof typeof DOMAIN_SCHEMAS
export type DomainPayload<T extends DomainType> = z.infer<(typeof DOMAIN_SCHEMAS)[T]>
export const DOMAIN_TYPES = Object.keys(DOMAIN_SCHEMAS) as DomainType[]

export const HAZARD_OPENING_TYPES: DomainType[] = ['HazardDetected', 'HazardRiskElevated']
export const HAZARD_CLOSING_TYPES: DomainType[] = ['HazardCleared', 'HazardConfirmedFalseAlarm']

export function isDomainType(type: string): type is DomainType {
  return type in DOMAIN_SCHEMAS
}

/** Validates a domain event payload. Unknown types or versions are permanent failures. */
export function parseDomainPayload<T extends DomainType>(env: Envelope, type: T): DomainPayload<T> {
  if (env.version !== 1) throw new PermanentError('UNSUPPORTED_VERSION', `${type} v${env.version} is not supported`)
  const result = DOMAIN_SCHEMAS[type].safeParse(env.payload)
  if (!result.success) throw new PermanentError('SCHEMA_INVALID', `${type}: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  return result.data as DomainPayload<T>
}

/** A typed domain event, ready to append. */
export interface DomainEventDraft<T extends DomainType = DomainType> {
  type: T
  payload: DomainPayload<T>
  occurredAt?: string
  causationId?: string | null
  correlationId?: string
}

export function draft<T extends DomainType>(type: T, payload: DomainPayload<T>, extra: Omit<DomainEventDraft<T>, 'type' | 'payload'> = {}): DomainEventDraft<T> {
  return { type, payload, ...extra }
}
