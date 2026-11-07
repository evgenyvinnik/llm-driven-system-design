/**
 * Event intake: idempotent emit, immutable event row, fan-out to matching
 * endpoints, and the transactional outbox, all in one PostgreSQL transaction.
 *
 * Success means that transaction committed. From then on the event and its
 * deliveries exist and an outbox row per delivery is waiting for the
 * publisher, even if this process, the publisher or RabbitMQ dies the next
 * millisecond. We never publish to RabbitMQ from the request path: a publish
 * after commit can be lost if the process dies in between, and a publish
 * before commit can announce an event that then rolls back.
 *
 * A producer that lost our response retries with the same Idempotency-Key and
 * gets the original event back (200, Idempotent-Replayed: true) instead of a
 * second event. The same key with a different body is a 409: the client has
 * a bug, and silently returning the old event would hide it.
 * @module api/services/emit
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { config } from '../../shared/config.js'
import { withTransaction } from '../../shared/db.js'
import { writeOutbox } from '../../shared/dispatch.js'
import { HttpError } from '../../shared/errors.js'
import { newId } from '../../shared/ids.js'
import { deliveriesFannedOut, eventsEmitted } from '../../shared/metrics.js'
import { EVENT_TYPE_PATTERN, matchesEventType } from '../../delivery/filter.js'
import { toEventDto, type EventDto, type EventRow } from './dto.js'

export const emitSchema = z
  .object({
    type: z.string().max(100).regex(EVENT_TYPE_PATTERN, 'Use dotted lowercase names such as order.created'),
    data: z.record(z.unknown()),
    orderingKey: z.string().min(1).max(200).optional(),
  })
  .strict()

export type EmitInput = z.infer<typeof emitSchema>

export interface EmitResult {
  event: EventDto
  deliveries: { id: string; endpointId: string }[]
  replayed: boolean
}

/** JSON with sorted keys, so a retried request with reordered keys hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function requestHash(input: EmitInput): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex')
}

export async function emitEvent(orgId: string, idempotencyKey: string, input: EmitInput, source: 'api' | 'console'): Promise<EmitResult> {
  const hash = requestHash(input)
  const bytes = Buffer.byteLength(JSON.stringify(input.data))
  if (bytes > config.delivery.maxPayloadBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `Event data is ${bytes} bytes; the limit is ${config.delivery.maxPayloadBytes}`)

  const result = await withTransaction(async (client) => {
    // Serialises concurrent emits with the same key, so exactly one inserts and the others see its row.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${orgId}:${idempotencyKey}`])
    const existing = await client.query<EventRow>('SELECT * FROM events WHERE org_id = $1 AND idempotency_key = $2', [orgId, idempotencyKey])
    if (existing.rows[0]) {
      const row = existing.rows[0]
      if (row.request_hash !== hash) {
        throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request body', { eventId: row.id })
      }
      const deliveries = await client.query<{ id: string; endpoint_id: string }>('SELECT id, endpoint_id FROM deliveries WHERE event_id = $1 ORDER BY id', [row.id])
      return { event: toEventDto(row), deliveries: deliveries.rows.map((d) => ({ id: d.id, endpointId: d.endpoint_id })), replayed: true }
    }

    let sequence: number | null = null
    if (input.orderingKey) {
      const seq = await client.query<{ last_sequence: string }>(
        `INSERT INTO ordering_sequences (org_id, ordering_key, last_sequence) VALUES ($1, $2, 1)
         ON CONFLICT (org_id, ordering_key) DO UPDATE SET last_sequence = ordering_sequences.last_sequence + 1
         RETURNING last_sequence`,
        [orgId, input.orderingKey],
      )
      sequence = Number(seq.rows[0].last_sequence)
    }

    const eventId = newId.event()
    const inserted = await client.query<EventRow>(
      `INSERT INTO events (id, org_id, type, payload, ordering_key, sequence, idempotency_key, request_hash, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [eventId, orgId, input.type, JSON.stringify(input.data), input.orderingKey ?? null, sequence, idempotencyKey, hash, source],
    )

    // Fan-out: one delivery per active endpoint whose filter matches. Disabled endpoints get nothing.
    const endpoints = await client.query<{ id: string; event_types: string[] }>(
      `SELECT id, event_types FROM endpoints WHERE org_id = $1 AND status = 'active' ORDER BY created_at`,
      [orgId],
    )
    const targets = endpoints.rows.filter((e) => matchesEventType(e.event_types, input.type))
    // Sorted by id so a replayed response lists them in the same order as the original.
    const deliveries = targets.map((e) => ({ id: newId.delivery(), endpointId: e.id })).sort((a, b) => (a.id < b.id ? -1 : 1))
    if (deliveries.length > 0) {
      await client.query(
        `INSERT INTO deliveries (id, event_id, endpoint_id, org_id, state, dispatch_seq, retry_deadline, queued_at)
         SELECT d.id, $3, d.endpoint_id, $4, 'queued', 1, now() + make_interval(secs => $5), now()
           FROM unnest($1::text[], $2::text[]) AS d(id, endpoint_id)`,
        [deliveries.map((d) => d.id), deliveries.map((d) => d.endpointId), eventId, orgId, config.delivery.retryHorizonSeconds],
      )
      await writeOutbox(
        client,
        deliveries.map((d) => ({ id: d.id, dispatchSeq: 1 })),
      )
    }
    return { event: toEventDto(inserted.rows[0]), deliveries, replayed: false }
  })

  if (result.replayed) eventsEmitted.inc({ outcome: 'idempotent_replay' })
  else {
    eventsEmitted.inc({ outcome: 'created' })
    deliveriesFannedOut.inc(result.deliveries.length)
  }
  return result
}
