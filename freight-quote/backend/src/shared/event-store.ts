/**
 * The append-only event log in PostgreSQL. It is the transactional outbox
 * (state changes and their events commit in one transaction; the relay
 * publishes rows to Valkey Streams afterwards) and the durable integration
 * backbone the analytics projection replays from. The quotes table, not this
 * log, is the source of truth for a quote's current state.
 *
 * Each stream (one per quote, tariff key, fuel schedule or dependency) has a
 * gapless per-stream version guarded by UNIQUE (stream_id, stream_version):
 * two writers racing on one stream cannot both commit, and the loser's
 * transaction rolls back and is retried by its caller.
 * @module shared/event-store
 */
import type pg from 'pg'
import { buildEnvelope, type NewEvent, type RawEnvelope } from './events.js'
import type { Queryable } from './db.js'

export class ConcurrencyError extends Error {
  constructor(streamId: string, expected: number, actual: number) {
    super(`stream ${streamId}: expected version ${expected}, found ${actual}`)
    this.name = 'ConcurrencyError'
  }
}

export interface StoredEvent extends RawEnvelope {
  position: number
  published_at: string | null
}

/**
 * Appends events in order. Events for the same stream get consecutive
 * versions. With `expectedVersion`, the first event's stream must currently be
 * at exactly that version (optimistic concurrency); otherwise the next version
 * is read inside the transaction and the unique constraint catches a race.
 */
export async function appendEvents(
  client: pg.PoolClient,
  events: NewEvent[],
  producer: string,
  options: { expectedVersion?: number } = {},
): Promise<RawEnvelope[]> {
  const written: RawEnvelope[] = []
  const next = new Map<string, number>()
  for (const event of events) {
    let version = next.get(event.streamId)
    if (version === undefined) {
      const { rows } = await client.query<{ v: number }>('SELECT COALESCE(MAX(stream_version), 0)::int AS v FROM events WHERE stream_id = $1', [event.streamId])
      const current = rows[0].v
      if (options.expectedVersion !== undefined && written.length === 0 && current !== options.expectedVersion) {
        throw new ConcurrencyError(event.streamId, options.expectedVersion, current)
      }
      version = current + 1
    }
    const env = buildEnvelope(event, producer)
    env.stream_version = version
    try {
      await client.query(
        `INSERT INTO events (event_id, type, version, stream_id, stream_version, occurred_at, recorded_at, correlation_id, causation_id, producer, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [env.event_id, env.type, env.version, env.stream_id, version, env.occurred_at, env.recorded_at, env.correlation_id, env.causation_id, env.producer, env.payload],
      )
    } catch (err) {
      if ((err as { code?: string }).code === '23505' && String((err as Error).message).includes('stream_version')) {
        throw new ConcurrencyError(event.streamId, version - 1, -1)
      }
      throw err
    }
    next.set(event.streamId, version + 1)
    written.push(env)
  }
  return written
}

/**
 * Records an event produced elsewhere (the pricing system) under its own
 * event_id. Returns false when the event is already in the log, which makes
 * the consumer that calls it idempotent on redelivery.
 */
export async function recordExternalEvent(client: pg.PoolClient, env: RawEnvelope): Promise<boolean> {
  const { rows } = await client.query<{ v: number }>('SELECT COALESCE(MAX(stream_version), 0)::int AS v FROM events WHERE stream_id = $1', [env.stream_id])
  const result = await client.query(
    `INSERT INTO events (event_id, type, version, stream_id, stream_version, occurred_at, recorded_at, correlation_id, causation_id, producer, payload)
     VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8, $9, $10)
     ON CONFLICT (event_id) DO NOTHING`,
    [env.event_id, env.type, env.version, env.stream_id, rows[0].v + 1, env.occurred_at, env.correlation_id, env.causation_id, env.producer, env.payload],
  )
  return (result.rowCount ?? 0) > 0
}

export function rowToEnvelope(row: Record<string, unknown>): StoredEvent {
  const ts = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null))
  return {
    position: Number(row.position),
    event_id: row.event_id as string,
    type: row.type as string,
    version: row.version as number,
    stream_id: row.stream_id as string,
    stream_version: row.stream_version as number,
    occurred_at: ts(row.occurred_at) as string,
    recorded_at: ts(row.recorded_at) as string,
    correlation_id: row.correlation_id as string,
    causation_id: (row.causation_id as string | null) ?? null,
    producer: row.producer as string,
    payload: row.payload as Record<string, unknown>,
    published_at: ts(row.published_at),
  }
}

export async function readStream(db: Queryable, streamId: string): Promise<StoredEvent[]> {
  const { rows } = await db.query('SELECT * FROM events WHERE stream_id = $1 ORDER BY stream_version', [streamId])
  return rows.map(rowToEnvelope)
}
