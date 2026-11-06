/**
 * The event envelope and schema evolution.
 *
 * Every event carries the same envelope: identity (event_id), what it is (type,
 * schema version), where it belongs (stream id and per-stream version, global
 * position), two clocks (occurred_at = event time, recorded_at = processing
 * time) and lineage (correlation_id for the business flow, causation_id for the
 * event that directly caused it).
 *
 * Schema evolution: producers write only the latest version; stored rows are
 * never rewritten. Readers upcast old versions step by step (v1 -> v2 -> ...)
 * before validating, so every consumer sees one shape. A consumer that meets a
 * version newer than it knows is running stale code: that is a permanent error
 * and the message goes to the dead-letter stream until the consumer is deployed.
 * @module events/envelope
 */
import { CATALOG, type StreamType } from './catalog.js'

export interface EventEnvelope<P = Record<string, unknown>> {
  eventId: string
  type: string
  /** Schema version after upcasting (always the latest). */
  version: number
  /** Schema version the event was written at. */
  storedVersion: number
  streamId: string
  streamType: StreamType
  streamVersion: number
  globalPosition: number
  family: string
  partitionKey: string
  occurredAt: string
  recordedAt: string
  committedAt: string
  correlationId: string
  causationId: string | null
  actor: string
  tags: string[]
  payload: P
}

/** The row as stored and as carried on the broker (payload at its stored version). */
export interface StoredEventRow {
  global_position: number | string
  event_id: string
  stream_id: string
  stream_type: StreamType
  stream_version: number
  type: string
  version: number
  family: string
  partition_key: string
  occurred_at: Date | string
  recorded_at: Date | string
  committed_at: Date | string
  correlation_id: string
  causation_id: string | null
  actor: string
  tags: string[]
  payload: Record<string, unknown>
}

type Upcaster = (payload: Record<string, unknown>) => Record<string, unknown>

/** upcasters[type][fromVersion] turns a fromVersion payload into fromVersion + 1. */
export const UPCASTERS: Record<string, Record<number, Upcaster>> = {
  InspectionFindingRecorded: {
    // v1 had no source: an alert id meant the inspection came from an alert, otherwise from a random audit.
    // v2 states the source (routine inspections and bearing-shop teardowns exist too) and can supersede.
    1: ({ alertId, ...rest }) => ({ ...rest, source: alertId ? 'alert' : 'audit', supersedesFindingId: null }),
  },
}

export class UnknownSchemaVersionError extends Error {
  readonly permanent = true
  constructor(type: string, version: number) {
    super(`${type} v${version} is newer than this consumer understands (or unknown); deploy the consumer, then redrive`)
  }
}

export function upcast(type: string, version: number, payload: Record<string, unknown>): { version: number; payload: Record<string, unknown> } {
  const def = CATALOG[type]
  if (!def || version > def.latest || !def.schemas[version]) throw new UnknownSchemaVersionError(type, version)
  let v = version
  let p = payload
  while (v < def.latest) {
    const step = UPCASTERS[type]?.[v]
    if (!step) throw new UnknownSchemaVersionError(type, v)
    p = step(p)
    v += 1
  }
  return { version: v, payload: p }
}

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString())

/** Stored row -> envelope at the latest schema version. */
export function toEnvelope(row: StoredEventRow): EventEnvelope {
  const { version, payload } = upcast(row.type, row.version, row.payload)
  return {
    eventId: row.event_id,
    type: row.type,
    version,
    storedVersion: row.version,
    streamId: row.stream_id,
    streamType: row.stream_type,
    streamVersion: row.stream_version,
    globalPosition: Number(row.global_position),
    family: row.family,
    partitionKey: row.partition_key,
    occurredAt: iso(row.occurred_at),
    recordedAt: iso(row.recorded_at),
    committedAt: iso(row.committed_at),
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    actor: row.actor,
    tags: row.tags ?? [],
    payload,
  }
}
