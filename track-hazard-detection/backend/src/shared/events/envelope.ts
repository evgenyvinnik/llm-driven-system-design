/**
 * The event envelope. Every event in the system, whether reported by an edge
 * gateway or appended to a hazard's stream, travels in this shape.
 *
 * - `occurredAt` is event time (when it happened in the field).
 * - `recordedAt` is processing time (when the cloud durably recorded it).
 * - `streamId` + `streamVersion`: for domain events the aggregate stream and its
 *   per-stream version (optimistic concurrency); for edge events the gateway
 *   stream (`gw-<id>`) and the gateway's sequence number.
 * - `partitionKey`: the track segment (or train id for train positions).
 * - `correlationId` ties a whole causal chain to the edge event that started it;
 *   `causationId` is the event that directly caused this one.
 * @module shared/events/envelope
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

export type Lane = 'critical' | 'bulk' | 'domain' | 'trains'

export interface EnvelopeMeta {
  lane?: Lane
  /** Recorded more than the lateness threshold after it occurred (set at ingest). */
  late?: boolean
  sensorId?: string | null
  segmentId?: string | null
  subdivisionId?: string | null
  /** Who caused a domain event: a service name or a username. */
  actor?: string
  /** Client command id for API commands (idempotency key). */
  commandId?: string
  /** Set when an ops user re-drove a dead letter. */
  redriveOf?: string
  [key: string]: unknown
}

export interface Envelope<P = unknown> {
  eventId: string
  type: string
  version: number
  occurredAt: string
  recordedAt: string
  streamId: string
  streamVersion: number
  partitionKey: string
  correlationId: string
  causationId: string | null
  source: string
  globalPosition?: number
  meta: EnvelopeMeta
  payload: P
}

/** Shape check for an envelope read off a stream. Payload validation happens per type, after upcasting. */
export const envelopeSchema = z.object({
  eventId: z.string().uuid(),
  type: z.string().min(1),
  version: z.number().int().positive(),
  occurredAt: z.string().datetime({ offset: true }),
  recordedAt: z.string().datetime({ offset: true }),
  streamId: z.string().min(1),
  streamVersion: z.number().int().nonnegative(),
  partitionKey: z.string().min(1),
  correlationId: z.string().min(1),
  causationId: z.string().nullable(),
  source: z.string().min(1),
  globalPosition: z.number().int().optional(),
  meta: z.record(z.unknown()).default({}),
  payload: z.unknown(),
})

export function newEventId(): string {
  return randomUUID()
}

/** Thrown by consumers for messages that can never succeed (bad schema, unknown version). They go straight to the DLQ. */
export class PermanentError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'PermanentError'
  }
}

/** Thrown for failures that may succeed later (a registry not yet updated, a dependency down). Retried, then dead-lettered. */
export class TransientError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'TransientError'
  }
}

export function parseEnvelope(raw: string): Envelope {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new PermanentError('INVALID_JSON', 'Message is not valid JSON')
  }
  const parsed = envelopeSchema.safeParse(json)
  if (!parsed.success) {
    throw new PermanentError('INVALID_ENVELOPE', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
  }
  return parsed.data as Envelope
}
