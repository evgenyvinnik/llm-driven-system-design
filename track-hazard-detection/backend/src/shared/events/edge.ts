/**
 * Edge event schemas (what gateways report), their versions and upcasters.
 *
 * Consumers only ever see the latest version of each type: `parseEdgePayload`
 * upcasts older payloads step by step, then validates against the latest
 * schema. A version with no upcaster (for example v3 from firmware newer than
 * the cloud) is a PermanentError and is dead-lettered, not guessed at.
 * Unknown extra fields are ignored (tolerant reader).
 * @module shared/events/edge
 */
import { z } from 'zod'
import { PermanentError } from './envelope.js'

export const EDGE_TYPES = [
  'SensorReadingReported',
  'CameraDetectionReported',
  'SlideFenceTripped',
  'WaterLevelReported',
  'SensorHeartbeatMissed',
  'TrainPositionReported',
] as const
export type EdgeType = (typeof EDGE_TYPES)[number]

export const sensorReadingV1 = z.object({
  sensorId: z.string().min(1),
  kind: z.enum(['vibration', 'rail_temp']),
  /** Edge aggregation window: the gateway sends one aggregate per window, not raw samples. */
  windowSec: z.number().positive(),
  peakMmS: z.number().nonnegative().optional(),
  rmsMmS: z.number().nonnegative().optional(),
  tempF: z.number().optional(),
})

export const DETECTION_CLASSES = ['vehicle', 'debris', 'person', 'animal', 'clear'] as const

export const cameraDetectionV1 = z.object({
  sensorId: z.string().min(1),
  detectionClass: z.enum(DETECTION_CLASSES),
  confidence: z.number().min(0).max(1),
  /** Object-storage reference to the frame; images never travel on the event stream. */
  imageRef: z.string().min(1),
})

export const cameraDetectionV2 = cameraDetectionV1.extend({
  /** Bounding box in normalised image coordinates; null when the v1 model did not report one. */
  bbox: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable(),
  modelVersion: z.string().min(1),
})

export const slideFenceTrippedV1 = z.object({
  sensorId: z.string().min(1),
  wire: z.number().int().positive(),
  /** The edge interlock already dropped the protecting signal to red; the cloud only records it. */
  interlockSignalDropped: z.boolean(),
  signalId: z.string().min(1),
})

export const waterLevelV1 = z.object({
  sensorId: z.string().min(1),
  inchesBelowRail: z.number(),
  risingInPerHr: z.number(),
})

export const heartbeatMissedV1 = z.object({
  sensorId: z.string().min(1),
  lastSeenAt: z.string().datetime({ offset: true }),
  missedIntervals: z.number().int().positive(),
})

export const trainPositionV1 = z.object({
  trainId: z.string().min(1),
  symbol: z.string().min(1),
  subdivisionId: z.string().min(1),
  milepost: z.number(),
  direction: z.enum(['increasing', 'decreasing']),
  speedMph: z.number().nonnegative(),
})

export type SensorReading = z.infer<typeof sensorReadingV1>
export type CameraDetection = z.infer<typeof cameraDetectionV2>
export type SlideFenceTripped = z.infer<typeof slideFenceTrippedV1>
export type WaterLevel = z.infer<typeof waterLevelV1>
export type HeartbeatMissed = z.infer<typeof heartbeatMissedV1>
export type TrainPosition = z.infer<typeof trainPositionV1>

export interface EdgePayloads {
  SensorReadingReported: SensorReading
  CameraDetectionReported: CameraDetection
  SlideFenceTripped: SlideFenceTripped
  WaterLevelReported: WaterLevel
  SensorHeartbeatMissed: HeartbeatMissed
  TrainPositionReported: TrainPosition
}

/** Latest schema version per type, and the schema for it. */
export const LATEST: Record<EdgeType, { version: number; schema: z.ZodTypeAny }> = {
  SensorReadingReported: { version: 1, schema: sensorReadingV1 },
  CameraDetectionReported: { version: 2, schema: cameraDetectionV2 },
  SlideFenceTripped: { version: 1, schema: slideFenceTrippedV1 },
  WaterLevelReported: { version: 1, schema: waterLevelV1 },
  SensorHeartbeatMissed: { version: 1, schema: heartbeatMissedV1 },
  TrainPositionReported: { version: 1, schema: trainPositionV1 },
}

type Upcaster = (payload: Record<string, unknown>) => Record<string, unknown>

/** Upcasters keyed by `${type}@${fromVersion}`; each lifts one version. */
export const UPCASTERS: Record<string, Upcaster> = {
  // v1 cameras ran a model that reported no bounding box and no model version.
  'CameraDetectionReported@1': (p) => ({ ...p, bbox: null, modelVersion: 'edge-v1 (unreported)' }),
}

export function isEdgeType(type: string): type is EdgeType {
  return (EDGE_TYPES as readonly string[]).includes(type)
}

/** Lifts a payload to the latest version of its type. Throws PermanentError for unknown types or versions. */
export function upcastEdge(type: string, version: number, payload: unknown): { version: number; payload: Record<string, unknown> } {
  if (!isEdgeType(type)) throw new PermanentError('UNKNOWN_TYPE', `Unknown edge event type ${type}`)
  const latest = LATEST[type].version
  if (!Number.isInteger(version) || version < 1 || version > latest) {
    throw new PermanentError('UNSUPPORTED_VERSION', `${type} v${version} is not supported (latest known is v${latest})`)
  }
  let current = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  for (let v = version; v < latest; v++) {
    const up = UPCASTERS[`${type}@${v}`]
    if (!up) throw new PermanentError('UNSUPPORTED_VERSION', `No upcaster for ${type} v${v}`)
    current = up(current)
  }
  return { version: latest, payload: current }
}

/** Upcast, then validate against the latest schema. */
export function parseEdgePayload<T extends EdgeType>(type: T, version: number, payload: unknown): EdgePayloads[T] {
  const lifted = upcastEdge(type, version, payload)
  const result = LATEST[type].schema.safeParse(lifted.payload)
  if (!result.success) {
    throw new PermanentError('SCHEMA_INVALID', `${type} v${version}: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  }
  return result.data as EdgePayloads[T]
}

/**
 * Priority lane policy, applied at ingest (server side, so a misconfigured
 * gateway cannot flood the critical lane) and by gateways for their own send
 * order. Anything that could be a hazard right now is critical; periodic
 * readings, coverage and malformed payloads are bulk.
 */
export function classifyLane(type: string, payload: unknown, spikeMmS = 12): 'critical' | 'bulk' {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  switch (type) {
    case 'SlideFenceTripped':
      return 'critical'
    case 'CameraDetectionReported':
      return typeof p.detectionClass === 'string' && p.detectionClass !== 'clear' ? 'critical' : 'bulk'
    case 'WaterLevelReported':
      return typeof p.inchesBelowRail === 'number' && p.inchesBelowRail <= 24 ? 'critical' : 'bulk'
    case 'SensorReadingReported':
      return p.kind === 'vibration' && typeof p.peakMmS === 'number' && p.peakMmS >= spikeMmS ? 'critical' : 'bulk'
    default:
      return 'bulk'
  }
}
