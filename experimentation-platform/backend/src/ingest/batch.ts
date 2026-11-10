/**
 * Pure ingest logic shared by the API (validate, correct clock skew, reject
 * what can't be analyzed) and the worker (rows and insert tokens).
 *
 * Clock skew: devices have wrong clocks. Each batch carries `sentAt` from the
 * device clock; the server knows when it received it. Shifting every event in
 * the batch by (receivedAt − sentAt) puts event times on the server clock
 * while keeping their order and spacing as the device saw them.
 * @module ingest/batch
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const id = z.string().min(1).max(128)
const identity = {
  eventId: z.string().uuid(),
  ts: z.number().int().positive(),
  anonymousId: id.optional(),
  userId: id.optional(),
  stableId: id.optional(),
  orgId: id.optional(),
}
const flagKey = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/)
const variantKey = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/)
const exposureFields = {
  ...identity,
  flagKey,
  flagVersion: z.number().int().min(1),
  variant: variantKey,
  unitType: z.enum(['user', 'org', 'anonymous']),
  unitId: id,
}

export const sdkEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('exposure'), ...exposureFields }).strict(),
  z.object({ type: z.literal('assignment'), ...exposureFields }).strict(),
  z
    .object({
      type: z.literal('conversion'),
      ...identity,
      name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
      value: z.number().finite().optional(),
    })
    .strict(),
])
export type SdkEvent = z.infer<typeof sdkEventSchema>

export const batchEnvelopeSchema = z.object({
  batchId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  sentAt: z.number().int().positive(),
  sdkInstanceId: z.string().max(64).optional(),
  clientKey: z.string().max(100).optional(),
  events: z.array(z.unknown()).min(1).max(500),
})
export type BatchEnvelope = z.infer<typeof batchEnvelopeSchema>

export interface PreparedEvent {
  event: SdkEvent
  /** Skew-corrected event time (ms, server clock). */
  ts: number
  /** Raw device time (ms); identical on every retry, so it picks the ClickHouse partition. */
  clientTs: number
}

/** What goes into one Valkey stream entry: an accepted SDK batch. */
export interface StreamBatch {
  environment: string
  batchId: string
  receivedAt: number
  sdkInstance: string
  skewMs: number
  events: PreparedEvent[]
}

export interface IngestLimits {
  maxEventAgeMs: number
  maxFutureMs: number
}

export interface Prepared {
  batch: StreamBatch
  rejected: { index: number; reason: string }[]
}

const EARLIEST_PLAUSIBLE = Date.UTC(2020, 0, 1)

export function prepareBatch(envelope: BatchEnvelope, environment: string, receivedAt: number, limits: IngestLimits): Prepared {
  const skewMs = receivedAt - envelope.sentAt
  const events: PreparedEvent[] = []
  const rejected: Prepared['rejected'] = []
  const seen = new Set<string>()
  envelope.events.forEach((raw, index) => {
    const parsed = sdkEventSchema.safeParse(raw)
    if (!parsed.success) {
      rejected.push({ index, reason: parsed.error.issues[0]?.message ?? 'invalid event' })
      return
    }
    const event = parsed.data
    if (seen.has(event.eventId)) {
      rejected.push({ index, reason: 'duplicate event id in batch' })
      return
    }
    seen.add(event.eventId)
    if (event.ts < EARLIEST_PLAUSIBLE || event.ts > receivedAt + 365 * 86_400_000) {
      rejected.push({ index, reason: 'implausible device timestamp' })
      return
    }
    const ts = event.ts + skewMs
    if (ts < receivedAt - limits.maxEventAgeMs) {
      rejected.push({ index, reason: 'too old to analyze' })
      return
    }
    if (ts > receivedAt + limits.maxFutureMs) {
      rejected.push({ index, reason: 'in the future' })
      return
    }
    events.push({ event, ts: Math.min(ts, receivedAt), clientTs: event.ts })
  })
  return {
    batch: { environment, batchId: envelope.batchId, receivedAt, sdkInstance: envelope.sdkInstanceId ?? '', skewMs, events },
    rejected,
  }
}

/** ClickHouse DateTime64(3, 'UTC') literal. */
export function chTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '')
}

export interface ClickHouseRows {
  exposures: Record<string, unknown>[]
  assignments: Record<string, unknown>[]
  conversions: Record<string, unknown>[]
}

export function toClickHouseRows(batches: StreamBatch[]): ClickHouseRows {
  const rows: ClickHouseRows = { exposures: [], assignments: [], conversions: [] }
  for (const b of batches) {
    for (const { event, ts, clientTs } of b.events) {
      const common = {
        event_id: event.eventId,
        environment: b.environment,
        sdk_instance: b.sdkInstance,
        anonymous_id: event.anonymousId ?? '',
        user_id: event.userId ?? '',
        ts: chTime(ts),
        client_ts: chTime(clientTs),
        received_at: chTime(b.receivedAt),
      }
      if (event.type === 'conversion') {
        rows.conversions.push({
          ...common,
          event_name: event.name,
          value: event.value ?? 0,
          // Attribution joins on the same id the experiment bucketed by; a signed-out
          // conversion's stable id is its anonymous id.
          stable_id: event.stableId ?? event.anonymousId ?? '',
          org_id: event.orgId ?? '',
        })
      } else {
        const row = {
          ...common,
          flag_key: event.flagKey,
          flag_version: event.flagVersion,
          variant: event.variant,
          unit_type: event.unitType,
          unit_id: event.unitId,
        }
        if (event.type === 'exposure') rows.exposures.push(row)
        else rows.assignments.push(row)
      }
    }
  }
  return rows
}

/**
 * Insert dedup token for one table's rows from a group of stream entries. The
 * same entries re-read after a crash (the consumer re-reads its own pending
 * entries first, in the same order and count) produce the same token, so
 * ClickHouse drops the repeated insert.
 */
export function insertToken(table: string, entryIds: string[]): string {
  return createHash('sha1').update(`${table}:${entryIds.join(',')}`).digest('hex')
}
