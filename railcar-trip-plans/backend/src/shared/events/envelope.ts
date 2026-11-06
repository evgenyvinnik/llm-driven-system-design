/**
 * The event envelope: what every event carries besides its payload.
 *
 *   eventId        unique id (producer-assigned for facts, service-assigned for decisions)
 *   type/version   schema identity; the log keeps the produced version, consumers upcast on read
 *   streamId       the aggregate/entity stream the event belongs to, with a per-stream version
 *   partitionKey   what the event is ordered by on its topic (car id or train run id)
 *   occurredAt     event time: when it happened in the world
 *   recordedAt     processing time: when we appended it
 *   correlationId  the business flow it belongs to (one train delay, one replan)
 *   causationId    the event that directly caused this one (null for facts from the field)
 * @module shared/events/envelope
 */
import { randomUUID } from 'node:crypto'
import type { Topic } from '../config.js'
import type { EventType, Payloads } from './schemas.js'
import { upcastPayload } from './upcasters.js'

export interface EventEnvelope<T extends EventType = EventType> {
  eventId: string
  type: T
  version: number
  streamId: string
  streamVersion: number
  position: number
  topic: Topic
  partitionKey: string
  occurredAt: string
  recordedAt: string
  correlationId: string
  causationId: string | null
  producer: string
  payload: Payloads[T]
  /** Set when a consumer read an older version through the upcasters. */
  upcastFrom?: number | null
}

export type AnyEnvelope = { [T in EventType]: EventEnvelope<T> }[EventType]

/** A new event before it is appended (no position or stream version yet). */
export interface NewEvent<T extends EventType = EventType> {
  eventId?: string
  type: T
  version?: number
  occurredAt: string
  correlationId?: string
  causationId?: string | null
  producer: string
  payload: Payloads[T]
  dedupeKey?: string | null
  /** Optimistic concurrency: the stream version the writer read. Omit for "append wherever". */
  expectedVersion?: number
}

export function newEvent<T extends EventType>(type: T, payload: Payloads[T], meta: Omit<NewEvent<T>, 'type' | 'payload'>): NewEvent<T> {
  return { type, payload, ...meta, eventId: meta.eventId ?? randomUUID() }
}

/** Causation helper: a decision caused by `cause` inherits its correlation id. */
export function causedBy(cause: Pick<EventEnvelope, 'eventId' | 'correlationId'>) {
  return { causationId: cause.eventId, correlationId: cause.correlationId }
}

export interface EventRow {
  position: number
  event_id: string
  type: string
  version: number
  stream_id: string
  stream_version: number
  topic: Topic
  partition_key: string
  occurred_at: Date | string
  recorded_at: Date | string
  correlation_id: string
  causation_id: string | null
  producer: string
  payload: Record<string, unknown>
}

const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString())

/** Row (or stream message) to envelope, upcast to the latest payload version. */
export function toEnvelope(row: EventRow): AnyEnvelope {
  const up = upcastPayload(row.type as EventType, row.version, row.payload)
  return {
    eventId: row.event_id,
    type: row.type as EventType,
    version: up.version,
    upcastFrom: up.upcastFrom,
    streamId: row.stream_id,
    streamVersion: row.stream_version,
    position: row.position,
    topic: row.topic,
    partitionKey: row.partition_key,
    occurredAt: iso(row.occurred_at),
    recordedAt: iso(row.recorded_at),
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    producer: row.producer,
    payload: up.payload,
  } as AnyEnvelope
}

/** Serialized form on a stream: the envelope exactly as stored (not upcast). */
export function toWire(row: EventRow): string {
  return JSON.stringify({ ...row, occurred_at: iso(row.occurred_at), recorded_at: iso(row.recorded_at) })
}

export function fromWire(raw: string): EventRow {
  return JSON.parse(raw) as EventRow
}
