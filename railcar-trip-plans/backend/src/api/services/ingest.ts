/**
 * Ingest: validate a batch of facts from producers and append them to the event store.
 *
 * Facts are never rejected for being late, out of order or about an unknown car: they happened. They are
 * rejected only when malformed (unknown type, unknown version, payload fails its schema) or claimed to
 * happen in the future. A resend (same event id) or a duplicate under a new id (same natural key, the
 * interchange feed's habit) is reported as `duplicate` and changes nothing.
 * @module api/services/ingest
 */
import { z } from 'zod'
import { withTransaction } from '../../shared/db.js'
import { appendAll } from '../../shared/event-store.js'
import { CATALOG } from '../../shared/events/catalog.js'
import type { NewEvent } from '../../shared/events/envelope.js'
import { isEventType, parsePayload, type EventType } from '../../shared/events/schemas.js'
import { nowMs } from '../../shared/clock.js'
import { eventsIngested, ingestLagMinutes } from '../../shared/metrics.js'

export const IngestEnvelope = z.object({
  eventId: z.string().uuid(),
  type: z.string().min(1).max(40),
  version: z.number().int().min(1).max(20),
  occurredAt: z.string().datetime({ offset: true }),
  producer: z.string().min(1).max(64),
  correlationId: z.string().uuid().optional(),
  payload: z.record(z.unknown()),
})

export const IngestBatch = z.object({ events: z.array(z.unknown()).min(1).max(1000) })

export interface IngestResult {
  eventId: string | null
  type: string | null
  status: 'accepted' | 'duplicate' | 'rejected'
  position?: number
  error?: string
}

const FUTURE_TOLERANCE_MS = 10 * 60_000

export function producerKind(producer: string): string {
  return producer.split(':')[0] || 'unknown'
}

/** Validates each event on its own; returns appendable events plus per-event rejections. */
export function validateBatch(raw: unknown[], now: number): { valid: Array<{ index: number; event: NewEvent }>; results: IngestResult[] } {
  const results: IngestResult[] = []
  const valid: Array<{ index: number; event: NewEvent }> = []
  raw.forEach((item, index) => {
    const env = IngestEnvelope.safeParse(item)
    if (!env.success) {
      results[index] = { eventId: null, type: null, status: 'rejected', error: env.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }
      return
    }
    const e = env.data
    if (!isEventType(e.type) || CATALOG[e.type as EventType].origin !== 'external') {
      results[index] = { eventId: e.eventId, type: e.type, status: 'rejected', error: `${e.type} is not an ingestible fact type` }
      return
    }
    if (Date.parse(e.occurredAt) > now + FUTURE_TOLERANCE_MS) {
      results[index] = { eventId: e.eventId, type: e.type, status: 'rejected', error: 'occurredAt is in the future' }
      return
    }
    try {
      const payload = parsePayload(e.type, e.version, e.payload)
      valid.push({ index, event: { eventId: e.eventId, type: e.type, version: e.version, occurredAt: e.occurredAt, producer: e.producer, correlationId: e.correlationId, payload } as NewEvent })
    } catch (err) {
      const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : (err as Error).message
      results[index] = { eventId: e.eventId, type: e.type, status: 'rejected', error: message }
    }
  })
  return { valid, results }
}

export async function ingest(raw: unknown[]): Promise<{ accepted: number; duplicates: number; rejected: number; results: IngestResult[] }> {
  const now = nowMs()
  const { valid, results } = validateBatch(raw, now)
  if (valid.length > 0) {
    const recordedAt = new Date(now)
    const appended = await withTransaction((tx) => appendAll(tx, valid.map((v) => v.event), recordedAt))
    appended.forEach((r, i) => {
      const { index, event } = valid[i]
      results[index] = r.status === 'appended' ? { eventId: r.eventId, type: event.type, status: 'accepted', position: r.position! } : { eventId: r.eventId, type: event.type, status: 'duplicate' }
      if (r.status === 'appended') ingestLagMinutes.observe({ producer_kind: producerKind(event.producer) }, Math.max(0, (now - Date.parse(event.occurredAt)) / 60_000))
    })
  }
  let accepted = 0
  let duplicates = 0
  let rejected = 0
  for (const r of results) {
    eventsIngested.inc({ type: r.type ?? 'invalid', outcome: r.status })
    if (r.status === 'accepted') accepted++
    else if (r.status === 'duplicate') duplicates++
    else rejected++
  }
  return { accepted, duplicates, rejected, results }
}
