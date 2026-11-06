/**
 * The domain event store and the transactional outbox.
 *
 * `appendToStream` inserts events with consecutive per-stream versions. The
 * UNIQUE (stream_id, stream_version) constraint is the optimistic concurrency
 * check: two writers that loaded the same version race, one wins, the other
 * gets a ConcurrencyError and re-decides on the new state.
 *
 * In the same transaction every appended event gets an outbox row, so an event
 * is published if and only if it was committed. The relay publishes outbox rows
 * to Valkey Streams (at-least-once); consumers dedupe by event id.
 * @module shared/event-store
 */
import type { Client, Queryable } from './db.js'
import { newEventId, type Envelope, type EnvelopeMeta, type Lane } from './events/envelope.js'
import type { DomainEventDraft } from './events/domain.js'

export class ConcurrencyError extends Error {
  constructor(public streamId: string, public expectedVersion: number) {
    super(`Stream ${streamId} moved past version ${expectedVersion}`)
    this.name = 'ConcurrencyError'
  }
}

export type Topic = 'edge.critical' | 'edge.bulk' | 'trains' | 'domain'

interface EventRow {
  global_position: number
  event_id: string
  stream_id: string
  stream_version: number
  type: string
  version: number
  partition_key: string
  occurred_at: Date
  recorded_at: Date
  correlation_id: string
  causation_id: string | null
  source: string
  meta: EnvelopeMeta
  payload: unknown
}

export function rowToEnvelope(r: EventRow): Envelope {
  return {
    eventId: r.event_id,
    type: r.type,
    version: r.version,
    occurredAt: new Date(r.occurred_at).toISOString(),
    recordedAt: new Date(r.recorded_at).toISOString(),
    streamId: r.stream_id,
    streamVersion: r.stream_version,
    partitionKey: r.partition_key,
    correlationId: r.correlation_id,
    causationId: r.causation_id,
    source: r.source,
    globalPosition: r.global_position,
    meta: r.meta ?? {},
    payload: r.payload,
  }
}

export async function loadStream(db: Queryable, streamId: string): Promise<Envelope[]> {
  const { rows } = await db.query<EventRow>('SELECT * FROM events WHERE stream_id = $1 ORDER BY stream_version', [streamId])
  return rows.map(rowToEnvelope)
}

export async function streamVersion(db: Queryable, streamId: string): Promise<number> {
  const { rows } = await db.query<{ v: number | null }>('SELECT max(stream_version) AS v FROM events WHERE stream_id = $1', [streamId])
  return rows[0]?.v ?? 0
}

export interface AppendOptions {
  partitionKey: string
  source: string
  meta?: EnvelopeMeta
  /** Defaults to the first draft's causation chain. */
  correlationId?: string
  causationId?: string | null
}

/**
 * Appends events to a stream at `expectedVersion` (0 for a new stream) and
 * writes their outbox rows. Must run inside a transaction.
 */
export async function appendToStream(client: Client, streamId: string, expectedVersion: number, drafts: DomainEventDraft[], opts: AppendOptions): Promise<Envelope[]> {
  const out: Envelope[] = []
  let version = expectedVersion
  for (const d of drafts) {
    version += 1
    const eventId = newEventId()
    const correlationId = d.correlationId ?? opts.correlationId ?? eventId
    const causationId = d.causationId !== undefined ? d.causationId : (opts.causationId ?? null)
    const meta = { ...(opts.meta ?? {}), lane: 'domain' as Lane }
    try {
      const { rows } = await client.query<EventRow>(
        `INSERT INTO events (event_id, stream_id, stream_version, type, version, partition_key, occurred_at, correlation_id, causation_id, source, meta, payload)
         VALUES ($1, $2, $3, $4, 1, $5, COALESCE($6::timestamptz, clock_timestamp()), $7, $8, $9, $10, $11)
         RETURNING *`,
        [eventId, streamId, version, d.type, opts.partitionKey, d.occurredAt ?? null, correlationId, causationId, opts.source, meta, d.payload],
      )
      const env = rowToEnvelope(rows[0])
      out.push(env)
      await enqueueOutbox(client, 'domain', 'domain', opts.partitionKey, env)
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new ConcurrencyError(streamId, expectedVersion)
      throw err
    }
  }
  return out
}

export async function enqueueOutbox(client: Queryable, topic: Topic, lane: Lane, partitionKey: string, env: Envelope): Promise<void> {
  await client.query('INSERT INTO outbox (event_id, topic, lane, partition_key, envelope) VALUES ($1, $2, $3, $4, $5)', [env.eventId, topic, lane, partitionKey, env])
}

/** Wakes the relay at commit (NOTIFY is transactional). */
export async function notifyOutbox(client: Queryable, lane: string): Promise<void> {
  await client.query(`SELECT pg_notify('outbox', $1)`, [lane])
}

/**
 * Runs `fn` and retries on optimistic-concurrency conflicts. `fn` must start
 * its own transaction and reload state each attempt.
 */
export async function withConcurrencyRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      if (!(err instanceof ConcurrencyError)) throw err
      lastErr = err
      await new Promise((r) => setTimeout(r, 10 * (i + 1)))
    }
  }
  throw lastErr
}
