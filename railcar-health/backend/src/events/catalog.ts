/**
 * The event catalog: every domain event type, its versioned zod schema, the
 * stream it belongs to and the broker stream (Kafka topic) it is published on.
 * events.md in the project root is the human-readable version of this file.
 *
 * Producers always write the latest version. Older versions stay in the store
 * forever (it is append-only) and are upcast on read (see upcasters.ts), so a
 * consumer only ever sees the latest shape.
 * @module events/catalog
 */
import { z } from 'zod'

const iso = z.string().datetime({ offset: true })
const tier = z.number().int().min(0).max(4)
const owner = z.object({ role: z.enum(['dispatcher', 'yard', 'owner']), id: z.string().nullable() })
const trigger = z.object({ detectorId: z.string(), passId: z.string(), passedAt: iso, lagSeconds: z.number().int() })
const alertKind = z.enum(['hot_bearing', 'hot_wheel', 'cold_wheel'])
const finding = z.enum(['confirmed_bearing_defect', 'brake_defect', 'wheel_defect', 'no_defect_found'])
const disposition = z.enum(['bad_order', 'release', 'repaired'])
const replacement = z.object({ componentId: z.string(), installedAt: iso, axle: z.number().int().min(1).max(12) })
const nullableStr = z.string().nullable()

export type StreamType = 'case' | 'car' | 'trip' | 'pass' | 'detector'

// ── Ingest and raw facts (outbox for the fact log) ──
const PassRecorded = z.object({
  detectorId: z.string(), passId: z.string(), tripId: z.string(), gatewayId: z.string(), direction: z.enum(['EB', 'WB']),
  passedAt: iso, receivedAt: iso, lagSeconds: z.number().int().min(0), lane: z.enum(['live', 'backfill']),
  speedMph: z.number(), ambientF: z.number(), axleCount: z.number().int(), aeiRead: z.boolean(), edgeAlarmCount: z.number().int(),
})
const AxleReadingsRecorded = z.object({
  detectorId: z.string(), passId: z.string(), tripId: z.string(), lane: z.enum(['live', 'backfill']), axleCount: z.number().int(),
  readingCount: z.number().int(), payloadSha: z.string(),
  /** Claim check: the readings themselves stay in the fact log, keyed by (detector, pass). */
  claimCheck: z.object({ store: z.literal('axle_readings'), detectorId: z.string(), passId: z.string() }),
  maxBearingF: z.number(), maxWheelF: z.number(),
})

// ── Identity ──
const ConsistVersionChanged = z.object({
  tripId: z.string(), symbol: z.string(), direction: z.enum(['EB', 'WB']), originYardId: z.string(), destinationYardId: z.string(),
  stops: z.array(z.string()), departedAt: iso, revision: z.number().int().min(1), effectiveAt: iso,
  units: z.array(z.object({ position: z.number().int(), unitId: z.string(), unitType: z.enum(['locomotive', 'car']), axleCount: z.number().int(), leadingEnd: z.enum(['A', 'B']) })),
  setOut: z.array(z.string()), pickedUp: z.array(z.string()),
})
const CarIdentified = z.object({
  tripId: z.string(), revision: z.number().int(), carId: z.string(), position: z.number().int(), leadingEnd: z.enum(['A', 'B']),
  source: z.enum(['consist', 'aei']), detectorId: z.string(), passId: z.string(),
  correctedFrom: z.object({ unitId: z.string(), leadingEnd: z.enum(['A', 'B']) }).nullable(),
})
const IdentityQuarantined = z.object({
  tripId: z.string(), detectorId: z.string(), passId: z.string(), reason: z.enum(['awaiting_consist', 'axle_count_mismatch']),
  detectedAxles: z.number().int(), expectedAxles: z.number().int().nullable(),
})

// ── Trends, trips and detectors ──
const BearingTrendUpdated = z.object({
  tripId: z.string(), carId: z.string(), position: z.string(), detectorId: z.string(), passId: z.string(), passedAt: iso,
  tier, excludedPreInstall: z.number().int(), features: z.record(z.unknown()),
})
const TripPositionUpdated = z.object({
  tripId: z.string(), symbol: z.string(), status: z.enum(['en_route', 'arrived']), detectorId: z.string(), milepost: z.number(), passedAt: iso,
  territoryId: z.string(), deskId: nullableStr, nextYardId: nullableStr, nextYardEta: iso.nullable(),
})
const TripArrived = z.object({ tripId: z.string(), symbol: z.string(), yardId: z.string(), arrivedAt: iso })
const DetectorHealthChanged = z.object({
  detectorId: z.string(), from: z.enum(['ok', 'offline', 'silent', 'biased']), to: z.enum(['ok', 'offline', 'silent', 'biased']),
  reason: nullableStr, biasOffsetF: z.number().nullable(), missedPasses: z.number().int(), lastHeardAt: iso.nullable(),
})

// ── The case aggregate: an alert (or an audit) and its yard response ──
const AlertRaised = z.object({
  caseId: z.string().uuid(), tripId: z.string(), symbol: z.string(), carId: z.string(), ownerMark: nullableStr, kind: alertKind, position: z.string(),
  tier, action: z.string(), routing: z.string(), deskId: nullableStr, territoryId: nullableStr, yardId: nullableStr,
  owner, ackDueAt: iso.nullable(), reasons: z.array(z.string()), features: z.record(z.unknown()), routeNote: z.string(), trigger, late: z.boolean(),
})
const AlertEscalated = z.object({
  caseId: z.string().uuid(), fromTier: tier, toTier: tier, action: z.string(), routing: z.string(), deskId: nullableStr, territoryId: nullableStr,
  yardId: nullableStr, owner, ackDueAt: iso.nullable(), reasons: z.array(z.string()), features: z.record(z.unknown()), routeNote: z.string(),
  trigger, late: z.boolean(), reopened: z.boolean(),
})
const AlertHandedOff = z.object({
  caseId: z.string().uuid(), from: owner, to: owner, reason: z.enum(['desk_territory', 'passed_yard']), ackDueAt: iso.nullable(), note: z.string(),
})
const CarHoldMoved = z.object({
  caseId: z.string().uuid(), holdId: z.string().uuid(), carId: z.string(), fromYardId: z.string(), toYardId: z.string(),
  workOrderId: z.string().uuid().nullable(), note: z.string(),
})
const AlertAcknowledged = z.object({
  caseId: z.string().uuid(), by: z.string(), action: z.string(), note: nullableStr, tier, via: z.enum(['console', 'inspection_started']),
})
const AckDeadlineMissed = z.object({
  caseId: z.string().uuid(), ownerRole: z.enum(['dispatcher', 'yard']), ownerId: nullableStr, fromLevel: z.number().int(), toLevel: z.number().int(),
  escalatedTo: z.string(), nextAckDueAt: iso.nullable(), note: z.string(),
})
const ApproachingYardWarned = z.object({ caseId: z.string().uuid(), yardId: z.string(), etaAt: iso, toLevel: z.number().int(), note: z.string() })
const NotificationRequested = z.object({
  caseId: z.string().uuid(), notificationId: z.string().uuid(), channel: z.enum(['dispatcher', 'yard', 'car_owner', 'reliability', 'supervisor', 'operations']),
  target: z.string(), kind: z.string(), message: z.string(),
})
const NotificationDelivered = z.object({
  caseId: z.string().uuid(), notificationId: z.string().uuid(), channel: z.string(), target: z.string(), provider: z.string(),
})
const CarHoldPlaced = z.object({
  caseId: z.string().uuid(), holdId: z.string().uuid(), carId: z.string(), yardId: z.string(), reason: z.string(), status: z.enum(['active', 'bad_ordered']),
})
const CarHoldReleased = z.object({ caseId: z.string().uuid(), holdId: z.string().uuid(), carId: z.string(), yardId: z.string(), by: z.string(), reason: z.string() })
const WorkOrderOpened = z.object({
  caseId: z.string().uuid(), workOrderId: z.string().uuid(), caseType: z.enum(['alert', 'audit']), tripId: nullableStr, carId: z.string(),
  position: z.string(), kind: z.string(), yardId: z.string(), priority: z.number().int().min(0).max(4),
})
const WorkOrderStarted = z.object({ caseId: z.string().uuid(), workOrderId: z.string().uuid(), by: z.string() })
const findingCommon = {
  caseId: z.string().uuid().nullable(), findingId: z.string().uuid(), workOrderId: z.string().uuid().nullable(), clientSubmissionId: nullableStr,
  carId: z.string(), position: z.string(), finding, disposition, notes: nullableStr, recordedBy: z.string(), observedAt: iso, replacement: replacement.nullable(),
}
/** v1: the source of a finding was implied by whether it had an alert. */
const InspectionFindingRecordedV1 = z.object({ ...findingCommon, alertId: z.string().uuid().nullable() })
/** v2: bearing-shop teardowns and routine inspections arrive too, so the source is stated. */
const InspectionFindingRecordedV2 = z.object({
  ...findingCommon, source: z.enum(['alert', 'audit', 'routine', 'teardown']), supersedesFindingId: z.string().uuid().nullable(),
})
const CaseClosed = z.object({
  caseId: z.string().uuid(), outcome: z.string(), reason: z.enum(['released', 'repaired', 'component_replaced', 'identity_corrected', 'audit_complete']),
  note: z.string(), closedBy: z.string(),
})

// ── The car aggregate: component history ──
const ComponentReplaced = z.object({
  carId: z.string(), axle: z.number().int().min(1).max(12), removedComponentId: nullableStr, installedComponentId: z.string(), installedAt: iso,
  recordedBy: z.string(), findingId: z.string().uuid().nullable(), caseId: z.string().uuid().nullable(), clientSubmissionId: nullableStr,
})

export interface EventDefinition {
  type: string
  latest: number
  schemas: Record<number, z.ZodTypeAny>
  streamTypes: StreamType[]
  description: string
}

const def = (type: string, streamTypes: StreamType[], schemas: Record<number, z.ZodTypeAny>, description: string): EventDefinition => ({
  type, streamTypes, schemas, description, latest: Math.max(...Object.keys(schemas).map(Number)),
})

export const CATALOG: Record<string, EventDefinition> = Object.fromEntries(
  [
    def('PassRecorded', ['pass'], { 1: PassRecorded }, 'A train passed a detector and the pass header was stored in the fact log'),
    def('AxleReadingsRecorded', ['pass'], { 1: AxleReadingsRecorded }, "The pass's per-axle readings were stored (claim check to the fact log)"),
    def('ConsistVersionChanged', ['trip'], { 1: ConsistVersionChanged }, 'A consist revision took effect (departure, or a train rebuilt at a yard)'),
    def('CarIdentified', ['trip'], { 1: CarIdentified }, 'A car was placed and oriented in a trip, from the consist or corrected by an AEI read'),
    def('IdentityQuarantined', ['trip'], { 1: IdentityQuarantined }, 'A pass could not be mapped to cars and is held rather than guessed'),
    def('BearingTrendUpdated', ['trip'], { 1: BearingTrendUpdated }, "A bearing's trend features changed with a new observation"),
    def('TripPositionUpdated', ['trip'], { 1: TripPositionUpdated }, "The train's newest position by event time, territory and next yard"),
    def('TripArrived', ['trip'], { 1: TripArrived }, 'The train arrived at its destination yard'),
    def('DetectorHealthChanged', ['detector'], { 1: DetectorHealthChanged }, 'A detector became ok, offline, silent or biased'),
    def('AlertRaised', ['case'], { 1: AlertRaised }, 'A risk alert was opened for a bearing or a brake: the case begins'),
    def('AlertEscalated', ['case'], { 1: AlertEscalated }, 'New evidence raised the tier in place (never lowered)'),
    def('AlertHandedOff', ['case'], { 1: AlertHandedOff }, 'Ownership moved to another desk or yard, which must acknowledge again'),
    def('CarHoldMoved', ['case'], { 1: CarHoldMoved }, 'The car went past its yard uninspected; hold and work order moved to the next yard'),
    def('AlertAcknowledged', ['case'], { 1: AlertAcknowledged }, 'The owner acknowledged: a person now owns it'),
    def('AckDeadlineMissed', ['case'], { 1: AckDeadlineMissed }, 'Nobody acknowledged in time; escalated to the next role in the chain'),
    def('ApproachingYardWarned', ['case'], { 1: ApproachingYardWarned }, "Unacknowledged and the train is close to the yard that must catch the car"),
    def('NotificationRequested', ['case'], { 1: NotificationRequested }, 'Someone must be told: a desk, a yard, the car owner, a supervisor'),
    def('NotificationDelivered', ['case'], { 1: NotificationDelivered }, 'The provider accepted the message (delivered is not acknowledged)'),
    def('CarHoldPlaced', ['case'], { 1: CarHoldPlaced }, 'The car may not be built into an outbound train until inspected'),
    def('CarHoldReleased', ['case'], { 1: CarHoldReleased }, 'The hold was lifted: released to service, repaired or superseded'),
    def('WorkOrderOpened', ['case'], { 1: WorkOrderOpened }, 'An inspection task was opened at a yard (alert or random audit)'),
    def('WorkOrderStarted', ['case'], { 1: WorkOrderStarted }, 'An inspector started the inspection'),
    def('InspectionFindingRecorded', ['case', 'car'], { 1: InspectionFindingRecordedV1, 2: InspectionFindingRecordedV2 }, 'What the inspector (or bearing shop) found: the label'),
    def('CaseClosed', ['case'], { 1: CaseClosed }, 'The case ended: released, repaired, superseded by a wheelset swap or by an identity correction'),
    def('ComponentReplaced', ['car'], { 1: ComponentReplaced }, 'A wheelset was changed out on an axle (event time = when it went on)'),
  ].map((d) => [d.type, d]),
)

export type EventType = keyof typeof CATALOG

/** Event types whose arrival can invalidate a person's view of a case (tier, owner or status). */
export const DECISION_EVENTS = new Set([
  'AlertRaised', 'AlertEscalated', 'AlertHandedOff', 'AlertAcknowledged', 'WorkOrderStarted', 'InspectionFindingRecorded', 'CarHoldReleased', 'CaseClosed',
])

/**
 * Broker stream (Kafka topic) per event family. The relay publishes each event to exactly one.
 * Readings are split into the live and backfill lanes at ingest, by how late the pass arrived.
 */
export function familyOf(type: string, streamType: StreamType, payload: Record<string, unknown>): string {
  if (streamType === 'case') return 'cases'
  if (streamType === 'car') return 'cars'
  switch (type) {
    case 'PassRecorded':
      return 'wayside.passes'
    case 'AxleReadingsRecorded':
      return payload.lane === 'backfill' ? 'wayside.readings.backfill' : 'wayside.readings.live'
    case 'ConsistVersionChanged':
    case 'CarIdentified':
    case 'IdentityQuarantined':
      return 'identity'
    case 'BearingTrendUpdated':
      return 'trends'
    case 'TripPositionUpdated':
    case 'TripArrived':
      return 'trips.position'
    case 'DetectorHealthChanged':
      return 'detectors.health'
    default:
      throw new Error(`no family for ${type}`)
  }
}

/** Kafka message key: the unit whose events must stay in order. */
export function partitionKeyOf(type: string, streamType: StreamType, streamId: string, payload: Record<string, unknown>): string {
  if (streamType === 'case') return String(payload.caseId ?? streamId.slice(5))
  if (streamType === 'car') return String(payload.carId ?? streamId.slice(4))
  if (type === 'PassRecorded' || type === 'DetectorHealthChanged') return String(payload.detectorId)
  return String(payload.tripId ?? streamId)
}

export function validatePayload(type: string, version: number, payload: unknown): void {
  const d = CATALOG[type]
  if (!d) throw new Error(`unknown event type ${type}`)
  const schema = d.schemas[version]
  if (!schema) throw new Error(`unknown version ${version} of ${type}`)
  schema.parse(payload)
}

export const streamIds = {
  case: (caseId: string) => `case-${caseId}`,
  car: (carId: string) => `car-${carId}`,
  trip: (tripId: string) => `trip-${tripId}`,
  pass: (detectorId: string, passId: string) => `pass-${detectorId}/${passId}`,
  detector: (detectorId: string) => `detector-${detectorId}`,
}

export function streamTypeOf(streamId: string): StreamType {
  const prefix = streamId.slice(0, streamId.indexOf('-'))
  if (['case', 'car', 'trip', 'pass', 'detector'].includes(prefix)) return prefix as StreamType
  throw new Error(`unknown stream ${streamId}`)
}
