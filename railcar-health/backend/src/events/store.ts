/**
 * The PostgreSQL event store.
 *
 * Writers stage events in an EventBatch during their transaction and commit the
 * batch as the transaction's last step. Commit takes a transaction-scoped
 * advisory lock, checks each stream's expected version, inserts the rows and
 * NOTIFYs the relay. The lock is held only from the INSERT to COMMIT, which
 * makes global positions visible in commit order: a reader that has seen
 * position N will never later discover a smaller one.
 *
 * Expected versions:
 *   number      the stream must be exactly at this version (aggregates: optimistic concurrency)
 *   'no_stream' the stream must not exist yet (creating an aggregate)
 *   'any'       no check (outbox streams with several independent writers, external facts)
 * @module events/store
 */
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { now } from '../shared/clock.js'
import { pool, withTransaction, type Queryable } from '../shared/db.js'
import { eventsAppended } from '../shared/metrics.js'
import { familyOf, partitionKeyOf, streamTypeOf, validatePayload, CATALOG } from './catalog.js'
import { toEnvelope, type EventEnvelope, type StoredEventRow } from './envelope.js'

export type ExpectedVersion = number | 'any' | 'no_stream'

export interface AppendContext {
  correlationId: string
  causationId?: string | null
  actor: string
}

export interface NewEvent {
  type: string
  payload: Record<string, unknown>
  occurredAt: Date | string
  /** Defaults to the catalog's latest version. Only the seed writes older versions (to show upcasting). */
  version?: number
  eventId?: string
  tags?: string[]
  /** Overrides the batch context for this event (e.g. an event caused by another event in the same batch). */
  causationId?: string | null
  /** Overrides the batch context (ingest: one flow per pass, many passes per request). */
  correlationId?: string
  recordedAt?: Date | string
}

export class ConcurrencyError extends Error {
  readonly code = 'CONCURRENCY_CONFLICT'
  constructor(
    readonly streamId: string,
    readonly expected: ExpectedVersion,
    readonly actual: number,
  ) {
    super(`stream ${streamId} is at version ${actual}, expected ${expected}`)
  }
}

/** Advisory lock key serializing the INSERT step of appends (not whole transactions). */
const APPEND_LOCK = 72_011_001

interface Staged {
  expected: ExpectedVersion
  events: Array<NewEvent & { eventId: string }>
}

export class EventBatch {
  private readonly streams = new Map<string, Staged>()

  constructor(readonly ctx: AppendContext) {}

  /**
   * Stages one event. The expected version is taken from the first event staged for a stream;
   * later events for the same stream follow it. Returns the event id (for causation links).
   */
  append(streamId: string, expected: ExpectedVersion, event: NewEvent): string {
    const eventId = event.eventId ?? randomUUID()
    const staged = this.streams.get(streamId)
    if (staged) staged.events.push({ ...event, eventId })
    else this.streams.set(streamId, { expected, events: [{ ...event, eventId }] })
    return eventId
  }

  get isEmpty(): boolean {
    return this.streams.size === 0
  }

  get size(): number {
    let n = 0
    for (const s of this.streams.values()) n += s.events.length
    return n
  }

  stagedTypes(): string[] {
    return [...this.streams.values()].flatMap((s) => s.events.map((e) => e.type))
  }

  /** Inserts every staged event inside the caller's transaction. */
  async commit(client: Queryable): Promise<EventEnvelope[]> {
    if (this.isEmpty) return []
    await client.query('SELECT pg_advisory_xact_lock($1)', [APPEND_LOCK])
    const ids = [...this.streams.keys()]
    const { rows: current } = await client.query<{ stream_id: string; v: number }>(
      'SELECT stream_id, max(stream_version)::int AS v FROM events WHERE stream_id = ANY($1) GROUP BY stream_id',
      [ids],
    )
    const versions = new Map(current.map((r) => [r.stream_id, r.v]))
    const recordedNow = now()
    const cols: Record<string, unknown[]> = {
      event_id: [], stream_id: [], stream_type: [], stream_version: [], type: [], version: [], family: [], partition_key: [],
      occurred_at: [], recorded_at: [], correlation_id: [], causation_id: [], actor: [], tags: [], payload: [],
    }
    for (const [streamId, staged] of this.streams) {
      const actual = versions.get(streamId) ?? 0
      if (staged.expected === 'no_stream' && actual !== 0) throw new ConcurrencyError(streamId, staged.expected, actual)
      if (typeof staged.expected === 'number' && staged.expected !== actual) throw new ConcurrencyError(streamId, staged.expected, actual)
      const streamType = streamTypeOf(streamId)
      staged.events.forEach((e, i) => {
        const version = e.version ?? CATALOG[e.type]?.latest ?? 1
        validatePayload(e.type, version, e.payload)
        cols.event_id.push(e.eventId)
        cols.stream_id.push(streamId)
        cols.stream_type.push(streamType)
        cols.stream_version.push(actual + i + 1)
        cols.type.push(e.type)
        cols.version.push(version)
        cols.family.push(familyOf(e.type, streamType, e.payload))
        cols.partition_key.push(partitionKeyOf(e.type, streamType, streamId, e.payload))
        cols.occurred_at.push(new Date(e.occurredAt))
        cols.recorded_at.push(e.recordedAt ? new Date(e.recordedAt) : recordedNow)
        cols.correlation_id.push(e.correlationId ?? this.ctx.correlationId)
        cols.causation_id.push(e.causationId !== undefined ? e.causationId : (this.ctx.causationId ?? null))
        cols.actor.push(this.ctx.actor)
        cols.tags.push(`{${[...new Set(e.tags ?? [])].map((t) => `"${t.replace(/"/g, '')}"`).join(',')}}`)
        cols.payload.push(JSON.stringify(e.payload))
      })
    }
    const { rows } = await client.query<StoredEventRow>(
      `INSERT INTO events (event_id, stream_id, stream_type, stream_version, type, version, family, partition_key, occurred_at, recorded_at,
                           correlation_id, causation_id, actor, tags, payload)
       SELECT u.event_id, u.stream_id, u.stream_type, u.stream_version, u.type, u.version, u.family, u.partition_key, u.occurred_at, u.recorded_at,
              u.correlation_id, u.causation_id, u.actor, u.tags::text[], u.payload::jsonb
         FROM unnest($1::uuid[], $2::text[], $3::text[], $4::int[], $5::text[], $6::smallint[], $7::text[], $8::text[], $9::timestamptz[], $10::timestamptz[],
                     $11::text[], $12::uuid[], $13::text[], $14::text[], $15::text[])
              WITH ORDINALITY AS u(event_id, stream_id, stream_type, stream_version, type, version, family, partition_key, occurred_at, recorded_at,
                                   correlation_id, causation_id, actor, tags, payload, ord)
        ORDER BY u.ord
       RETURNING *`,
      [cols.event_id, cols.stream_id, cols.stream_type, cols.stream_version, cols.type, cols.version, cols.family, cols.partition_key,
        cols.occurred_at, cols.recorded_at, cols.correlation_id, cols.causation_id, cols.actor, cols.tags, cols.payload],
    )
    const last = rows.reduce((m, r) => Math.max(m, Number(r.global_position)), 0)
    await client.query('SELECT pg_notify($1, $2)', ['rh_events', String(last)])
    this.streams.clear()
    for (const r of rows) eventsAppended.inc({ type: r.type })
    return rows.map(toEnvelope)
  }
}

const SELECT_EVENTS = 'SELECT * FROM events'

export async function readStream(db: Queryable, streamId: string): Promise<EventEnvelope[]> {
  const { rows } = await db.query<StoredEventRow>(`${SELECT_EVENTS} WHERE stream_id = $1 ORDER BY stream_version`, [streamId])
  return rows.map(toEnvelope)
}

export async function readStreams(db: Queryable, streamIds: string[], types?: string[]): Promise<EventEnvelope[]> {
  if (streamIds.length === 0) return []
  const { rows } = await db.query<StoredEventRow>(
    `${SELECT_EVENTS} WHERE stream_id = ANY($1) ${types ? 'AND type = ANY($2)' : ''} ORDER BY global_position`,
    types ? [streamIds, types] : [streamIds],
  )
  return rows.map(toEnvelope)
}

export async function readEvent(db: Queryable, eventId: string): Promise<{ envelope: EventEnvelope; stored: StoredEventRow } | null> {
  const { rows } = await db.query<StoredEventRow>(`${SELECT_EVENTS} WHERE event_id = $1`, [eventId])
  return rows[0] ? { envelope: toEnvelope(rows[0]), stored: rows[0] } : null
}

export async function headPosition(db: Queryable = pool): Promise<number> {
  const { rows } = await db.query<{ p: string | null }>('SELECT max(global_position) AS p FROM events')
  return Number(rows[0]?.p ?? 0)
}

export interface EventTx {
  client: pg.PoolClient
  batch: EventBatch
}

/**
 * Runs fn in a transaction with a fresh EventBatch committed at the end. A ConcurrencyError
 * (someone appended to a stream we read) re-runs fn from the start, re-reading every aggregate,
 * so the command is re-decided against the new state: never last-write-wins.
 */
export async function withEventTransaction<T>(
  ctx: AppendContext,
  fn: (tx: EventTx) => Promise<T>,
  retries = 3,
): Promise<{ result: T; events: EventEnvelope[] }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withTransaction(async (client) => {
        const batch = new EventBatch(ctx)
        const result = await fn({ client, batch })
        const events = await batch.commit(client)
        return { result, events }
      })
    } catch (err) {
      if (err instanceof ConcurrencyError && attempt < retries) continue
      throw err
    }
  }
}

export const newCorrelationId = () => randomUUID()
