/**
 * Event schemas: one zod schema per (type, version). The log stores every event exactly as it was produced
 * (type + version + payload); consumers read through the upcasters in `upcasters.ts`, so handler code only
 * ever sees the latest version of each type.
 *
 * Names are past tense: an event is something that happened (a fact from the field, or a decision a service
 * made), never a request.
 * @module shared/events/schemas
 */
import { z } from 'zod'

const iso = z.string().datetime({ offset: true })
const id = z.string().min(1).max(64)

// ── Car movement facts (producers: AEI readers, yard systems, the interchange EDI bridge) ──

export const CarSightedV1 = z.object({
  carId: id,
  siteId: id,
  trainRunId: id.nullable().default(null),
  direction: z.enum(['E', 'W']).nullable().default(null),
  railroad: z.string().min(2).max(8).default('PN'),
})
/** v2 adds what newer reader firmware reports: read confidence and which end of the car led. */
export const CarSightedV2 = CarSightedV1.extend({
  readerConfidence: z.number().min(0).max(1).nullable(),
  orientation: z.enum(['A_END_LEADING', 'B_END_LEADING', 'UNKNOWN']),
})

export const CarArrivedYardV1 = z.object({
  carId: id,
  yardId: id,
  trainRunId: id.nullable().default(null),
  track: z.string().max(16).nullable().default(null),
})

export const CarDepartedYardV1 = z.object({ carId: id, yardId: id, trainRunId: id })

export const CarPlacedV1 = z.object({
  carId: id,
  customerId: id,
  yardId: id.nullable().default(null),
  railroad: z.string().min(2).max(8).default('PN'),
})

export const CarPulledV1 = z.object({ carId: id, customerId: id, yardId: id })

export const CarBadOrderedV1 = z.object({
  carId: id,
  yardId: id,
  defect: z.string().min(1).max(120),
  estimatedRepairHours: z.number().positive().nullable().default(null),
})

export const CarInterchangedV1 = z.object({
  carId: id,
  interchangePoint: id,
  direction: z.enum(['delivered', 'received']),
  fromRoad: z.string().min(2).max(8),
  toRoad: z.string().min(2).max(8),
  waybillRef: z.string().max(32).nullable().default(null),
})

// ── Train movement facts (producer: the train movement / dispatch system) ──

export const TrainDepartedV1 = z.object({
  runId: id,
  trainId: id,
  fromYard: id,
  toYard: id,
  consist: z.array(id).max(400),
})

export const TrainArrivedV1 = z.object({ runId: id, trainId: id, yardId: id })

export const TrainDelayedV1 = z.object({
  runId: id,
  trainId: id,
  delayMinutes: z.number().int().min(1),
  newEtaAt: iso,
  location: z.string().max(64),
  reason: z.string().max(120),
})

export const TrainCancelledV1 = z.object({ runId: id, trainId: id, fromYard: id, reason: z.string().max(120) })

// ── Trip plans (event-sourced aggregate: stream plan-<tripId>) ──

export const Leg = z.object({
  seq: z.number().int().min(0),
  trainId: id,
  runId: id,
  fromYard: id,
  toYard: id,
  plannedDeparture: iso,
  plannedArrival: iso,
})
export type Leg = z.infer<typeof Leg>

const PlanReason = z.object({
  code: z.enum(['initial', 'missed_connection', 'train_cancelled', 'manual']),
  text: z.string().max(240),
  missedRunId: id.nullable().default(null),
  yardId: id.nullable().default(null),
})

export const TripPlanCreatedV1 = z.object({
  tripId: id,
  carId: id,
  shipperId: id,
  originYard: id,
  destinationYard: id,
  destinationCustomer: id,
  handoffRoad: z.string().max(8).nullable(),
  releasedAt: iso,
  version: z.literal(1),
  legs: z.array(Leg).min(1),
  reason: PlanReason,
})

export const TripPlanRevisedV1 = z.object({
  tripId: id,
  carId: id,
  shipperId: id,
  version: z.number().int().min(2),
  previousVersion: z.number().int().min(1),
  legs: z.array(Leg).min(1),
  reason: PlanReason,
  revisedBy: z.string().max(64),
  sagaId: id.nullable().default(null),
})

// ── Decisions made by consumers ──

export const ConnectionMissedV1 = z.object({
  carId: id,
  tripId: id,
  shipperId: id,
  planVersion: z.number().int(),
  legSeq: z.number().int(),
  runId: id,
  trainId: id,
  yardId: id,
  plannedDeparture: iso,
  reason: z.enum(['inbound_delay', 'departed_without_car']),
  /** True when detected before the outbound train left (from a delay on the inbound train). */
  predicted: z.boolean(),
  /** Earliest time the car can leave the yard on another train. */
  availableAt: iso,
  inboundRunId: id.nullable().default(null),
})

export const EtaUpdatedV1 = z.object({
  carId: id,
  tripId: id,
  shipperId: id,
  planVersion: z.number().int(),
  p10: iso,
  p50: iso,
  p90: iso,
  previousP50: iso.nullable(),
  shiftMinutes: z.number().int().nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
  asOf: iso,
  trigger: z.string().max(40),
  final: z.boolean(),
})

export const ExceptionOpenedV1 = z.object({
  exceptionId: id,
  carId: id,
  tripId: id.nullable(),
  shipperId: id.nullable(),
  type: z.enum(['missed_connection', 'train_cancelled', 'no_capacity', 'bad_order', 'dwell_exceeded']),
  severity: z.enum(['low', 'medium', 'high']),
  yardId: id.nullable(),
  summary: z.string().max(240),
  detail: z.record(z.unknown()),
})

export const ExceptionResolvedV1 = z.object({
  exceptionId: id,
  carId: id,
  resolution: z.string().max(240),
  resolvedBy: z.string().max(64),
})

const SagaRef = z.object({ sagaId: id, carId: id, tripId: id })

export const ReplanStartedV1 = SagaRef.extend({
  shipperId: id,
  trigger: z.enum(['inbound_delay', 'departed_without_car', 'train_cancelled']),
  fromPlanVersion: z.number().int(),
  legSeq: z.number().int(),
  yardId: id,
  missedRunId: id,
  readyAt: iso,
  attempt: z.number().int().min(1),
  parentSagaId: id.nullable(),
})

export const TrainCapacityReservedV1 = SagaRef.extend({ runId: id, trainId: id, departure: iso })
export const TrainCapacityReleasedV1 = SagaRef.extend({ runId: id, reason: z.string().max(120) })

const EtaPoint = z.object({ p10: iso.optional(), p50: iso, p90: iso })

export const ReplanCompletedV1 = SagaRef.extend({
  shipperId: id,
  fromPlanVersion: z.number().int(),
  toPlanVersion: z.number().int(),
  chosenRunId: id,
  etaBefore: EtaPoint.nullable(),
  etaAfter: EtaPoint.nullable(),
  shiftMinutes: z.number().int().nullable(),
  reasonText: z.string().max(240),
})

export const ReplanFailedV1 = SagaRef.extend({ shipperId: id, reason: z.string().max(240), yardId: id })
export const ReplanCompensatedV1 = SagaRef.extend({ reason: z.string().max(240), releasedRunId: id })

// ── Time as an event ──

/**
 * The event-time clock advanced past a tick boundary. Emitted from the watermark (the newest event time
 * reported from the field), so "time passing" is in the log like everything else: the ETA consumer
 * recomputes on it, and a replay sees the same ticks.
 */
export const ClockTickedV1 = z.object({ at: iso, watermark: iso })

// ── Notifications ──

export const ShipperNotifiedV1 = z.object({
  shipperId: id,
  digestId: id,
  carIds: z.array(id),
  itemCount: z.number().int(),
  suppressedCount: z.number().int(),
  channel: z.enum(['email']),
  subject: z.string().max(200),
  lines: z.array(z.string().max(400)),
})

/** Every (type, version) the system understands. `latest` is what handlers see after upcasting. */
export const SCHEMAS = {
  CarSighted: { latest: 2, versions: { 1: CarSightedV1, 2: CarSightedV2 } },
  CarArrivedYard: { latest: 1, versions: { 1: CarArrivedYardV1 } },
  CarDepartedYard: { latest: 1, versions: { 1: CarDepartedYardV1 } },
  CarPlaced: { latest: 1, versions: { 1: CarPlacedV1 } },
  CarPulled: { latest: 1, versions: { 1: CarPulledV1 } },
  CarBadOrdered: { latest: 1, versions: { 1: CarBadOrderedV1 } },
  CarInterchanged: { latest: 1, versions: { 1: CarInterchangedV1 } },
  TrainDeparted: { latest: 1, versions: { 1: TrainDepartedV1 } },
  TrainArrived: { latest: 1, versions: { 1: TrainArrivedV1 } },
  TrainDelayed: { latest: 1, versions: { 1: TrainDelayedV1 } },
  TrainCancelled: { latest: 1, versions: { 1: TrainCancelledV1 } },
  TripPlanCreated: { latest: 1, versions: { 1: TripPlanCreatedV1 } },
  TripPlanRevised: { latest: 1, versions: { 1: TripPlanRevisedV1 } },
  ConnectionMissed: { latest: 1, versions: { 1: ConnectionMissedV1 } },
  EtaUpdated: { latest: 1, versions: { 1: EtaUpdatedV1 } },
  ExceptionOpened: { latest: 1, versions: { 1: ExceptionOpenedV1 } },
  ExceptionResolved: { latest: 1, versions: { 1: ExceptionResolvedV1 } },
  ReplanStarted: { latest: 1, versions: { 1: ReplanStartedV1 } },
  TrainCapacityReserved: { latest: 1, versions: { 1: TrainCapacityReservedV1 } },
  TrainCapacityReleased: { latest: 1, versions: { 1: TrainCapacityReleasedV1 } },
  ReplanCompleted: { latest: 1, versions: { 1: ReplanCompletedV1 } },
  ReplanFailed: { latest: 1, versions: { 1: ReplanFailedV1 } },
  ReplanCompensated: { latest: 1, versions: { 1: ReplanCompensatedV1 } },
  ShipperNotified: { latest: 1, versions: { 1: ShipperNotifiedV1 } },
  ClockTicked: { latest: 1, versions: { 1: ClockTickedV1 } },
} as const

export type EventType = keyof typeof SCHEMAS

export interface Payloads {
  CarSighted: z.infer<typeof CarSightedV2>
  CarArrivedYard: z.infer<typeof CarArrivedYardV1>
  CarDepartedYard: z.infer<typeof CarDepartedYardV1>
  CarPlaced: z.infer<typeof CarPlacedV1>
  CarPulled: z.infer<typeof CarPulledV1>
  CarBadOrdered: z.infer<typeof CarBadOrderedV1>
  CarInterchanged: z.infer<typeof CarInterchangedV1>
  TrainDeparted: z.infer<typeof TrainDepartedV1>
  TrainArrived: z.infer<typeof TrainArrivedV1>
  TrainDelayed: z.infer<typeof TrainDelayedV1>
  TrainCancelled: z.infer<typeof TrainCancelledV1>
  TripPlanCreated: z.infer<typeof TripPlanCreatedV1>
  TripPlanRevised: z.infer<typeof TripPlanRevisedV1>
  ConnectionMissed: z.infer<typeof ConnectionMissedV1>
  EtaUpdated: z.infer<typeof EtaUpdatedV1>
  ExceptionOpened: z.infer<typeof ExceptionOpenedV1>
  ExceptionResolved: z.infer<typeof ExceptionResolvedV1>
  ReplanStarted: z.infer<typeof ReplanStartedV1>
  TrainCapacityReserved: z.infer<typeof TrainCapacityReservedV1>
  TrainCapacityReleased: z.infer<typeof TrainCapacityReleasedV1>
  ReplanCompleted: z.infer<typeof ReplanCompletedV1>
  ReplanFailed: z.infer<typeof ReplanFailedV1>
  ReplanCompensated: z.infer<typeof ReplanCompensatedV1>
  ShipperNotified: z.infer<typeof ShipperNotifiedV1>
  ClockTicked: z.infer<typeof ClockTickedV1>
}

export function isEventType(value: string): value is EventType {
  return Object.prototype.hasOwnProperty.call(SCHEMAS, value)
}

/** Validates a payload against the schema of the version it claims. Throws ZodError or Error. */
export function parsePayload(type: EventType, version: number, payload: unknown): Record<string, unknown> {
  const entry = SCHEMAS[type] as { latest: number; versions: Record<number, z.ZodTypeAny> }
  const schema = entry.versions[version]
  if (!schema) throw new UnsupportedVersionError(type, version)
  return schema.parse(payload) as Record<string, unknown>
}

export class UnsupportedVersionError extends Error {
  constructor(
    readonly type: string,
    readonly version: number,
  ) {
    super(`${type} v${version} is not a known schema version`)
  }
}
