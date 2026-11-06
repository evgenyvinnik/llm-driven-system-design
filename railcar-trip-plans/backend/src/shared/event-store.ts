/**
 * The event store: an append-only PostgreSQL table that is both the source of truth and the outbox.
 *
 * - `append` validates the payload against its (type, version) schema, takes a per-stream advisory lock,
 *   checks the expected stream version (optimistic concurrency) when the writer gives one, and inserts.
 *   A resend with the same event id, or a fact with the same natural key, is a no-op (`duplicate`).
 * - The log indexes (event_cars, train_run_cars, plan_run_index) are written in the same transaction, so a
 *   car's timeline query never misses an event that committed.
 * - The relay publishes rows whose `published_at` is null; nothing else publishes, so no event reaches a
 *   stream without its commit and no commit is left unpublished.
 * @module shared/event-store
 */
import type { PoolClient } from 'pg'
import type { Queryable } from './db.js'
import { routeOf, naturalKey } from './events/catalog.js'
import { toEnvelope, type AnyEnvelope, type EventRow, type NewEvent } from './events/envelope.js'
import { SCHEMAS, parsePayload, type EventType, type Payloads } from './events/schemas.js'
import { nowMs } from './clock.js'
import { eventsAppended } from './metrics.js'
import { randomUUID } from 'node:crypto'

export class ConcurrencyError extends Error {
  constructor(
    readonly streamId: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`Stream ${streamId} is at version ${actual}, expected ${expected}`)
  }
}

export interface AppendResult {
  status: 'appended' | 'duplicate'
  eventId: string
  position: number | null
  streamId: string
  streamVersion: number | null
}

const EVENT_COLUMNS =
  'position, event_id, type, version, stream_id, stream_version, topic, partition_key, occurred_at, recorded_at, correlation_id, causation_id, producer, payload'

/** Appends one event inside the caller's transaction. */
export async function append<T extends EventType>(tx: PoolClient, ev: NewEvent<T>, recordedAt: Date = new Date(nowMs())): Promise<AppendResult> {
  const version = ev.version ?? SCHEMAS[ev.type].latest
  const payload = parsePayload(ev.type, version, ev.payload) as Payloads[T]
  const route = routeOf(ev.type, payload)
  const eventId = ev.eventId ?? randomUUID()
  const dedupeKey = ev.dedupeKey === undefined ? naturalKey(ev.type, payload as Record<string, unknown>, ev.occurredAt) : ev.dedupeKey

  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [route.streamId])
  const { rows } = await tx.query<{ v: number }>('SELECT COALESCE(MAX(stream_version), 0)::int AS v FROM events WHERE stream_id = $1', [route.streamId])
  const current = rows[0].v
  if (ev.expectedVersion !== undefined && ev.expectedVersion !== current) {
    throw new ConcurrencyError(route.streamId, ev.expectedVersion, current)
  }

  const inserted = await tx.query<{ position: number }>(
    `INSERT INTO events (event_id, type, version, stream_id, stream_version, topic, partition_key, occurred_at, recorded_at,
                         correlation_id, causation_id, producer, dedupe_key, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT DO NOTHING
     RETURNING position`,
    [
      eventId,
      ev.type,
      version,
      route.streamId,
      current + 1,
      route.topic,
      route.partitionKey,
      ev.occurredAt,
      recordedAt.toISOString(),
      ev.correlationId ?? eventId,
      ev.causationId ?? null,
      ev.producer,
      dedupeKey,
      JSON.stringify(payload),
    ],
  )
  if (inserted.rowCount === 0) {
    return { status: 'duplicate', eventId, position: null, streamId: route.streamId, streamVersion: null }
  }
  const position = inserted.rows[0].position
  await writeIndexes(tx, ev.type, payload, position, route.cars)
  await tx.query("SELECT pg_notify('tp_events', $1)", [route.topic])
  eventsAppended.inc({ type: ev.type })
  return { status: 'appended', eventId, position, streamId: route.streamId, streamVersion: current + 1 }
}

async function writeIndexes(tx: PoolClient, type: EventType, payload: unknown, position: number, cars: string[]): Promise<void> {
  if (cars.length > 0) {
    await tx.query('INSERT INTO event_cars (position, car_id) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING', [position, cars])
  }
  if (type === 'TrainDeparted') {
    const p = payload as Payloads['TrainDeparted']
    await tx.query('INSERT INTO train_run_cars (run_id, car_id) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING', [p.runId, p.consist])
  }
  if (type === 'TripPlanCreated' || type === 'TripPlanRevised') {
    const p = payload as Payloads['TripPlanCreated']
    await tx.query('INSERT INTO plan_run_index (trip_id, car_id, run_id) SELECT $1, $2, unnest($3::text[]) ON CONFLICT DO NOTHING', [
      p.tripId,
      p.carId,
      p.legs.map((l) => l.runId),
    ])
  }
}

/** Appends several events; streams are locked in a stable order so concurrent batches cannot deadlock. */
export async function appendAll(tx: PoolClient, events: NewEvent[], recordedAt?: Date): Promise<AppendResult[]> {
  const order = events.map((ev, i) => ({ ev, i, stream: routeOf(ev.type, ev.payload as never).streamId }))
  order.sort((a, b) => (a.stream < b.stream ? -1 : a.stream > b.stream ? 1 : a.i - b.i))
  const results: AppendResult[] = new Array(events.length)
  for (const { ev, i } of order) results[i] = await append(tx, ev, recordedAt)
  return results
}

export async function readStream(q: Queryable, streamId: string): Promise<AnyEnvelope[]> {
  const { rows } = await q.query<EventRow>(`SELECT ${EVENT_COLUMNS} FROM events WHERE stream_id = $1 ORDER BY stream_version`, [streamId])
  return rows.map(toEnvelope)
}

export async function streamVersion(q: Queryable, streamId: string): Promise<number> {
  const { rows } = await q.query<{ v: number }>('SELECT COALESCE(MAX(stream_version), 0)::int AS v FROM events WHERE stream_id = $1', [streamId])
  return rows[0].v
}

/**
 * Everything relevant to one car, in log order: events that name it, plus every event of each train run it
 * rode or any version of its plan named (so a delay or cancellation of a planned train is included).
 * `upTo` limits the read to a log position (used by replay).
 */
export async function loadCarTimeline(q: Queryable, carId: string, upTo: number = Number.MAX_SAFE_INTEGER): Promise<AnyEnvelope[]> {
  const { rows } = await q.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events
      WHERE position <= $2
        AND position IN (
          SELECT position FROM event_cars WHERE car_id = $1
          UNION
          SELECT e.position FROM events e
           WHERE e.stream_id IN (
             SELECT 'train-' || run_id FROM train_run_cars WHERE car_id = $1
             UNION
             SELECT 'train-' || run_id FROM plan_run_index WHERE car_id = $1))
      ORDER BY position`,
    [carId, upTo],
  )
  return rows.map(toEnvelope)
}

/** The event-time watermark: the newest event time reported from the field (decisions excluded). */
export async function fieldWatermark(q: Queryable, upTo: number = Number.MAX_SAFE_INTEGER): Promise<Date | null> {
  const { rows } = await q.query<{ wm: Date | null }>("SELECT MAX(occurred_at) AS wm FROM events WHERE producer NOT LIKE 'svc:%' AND position <= $1", [upTo])
  return rows[0]?.wm ?? null
}

/** The newest ClockTicked boundary at or before a log position. */
export async function latestTick(q: Queryable, upTo: number = Number.MAX_SAFE_INTEGER): Promise<string | null> {
  const { rows } = await q.query<{ at: string | null }>("SELECT MAX(payload->>'at') AS at FROM events WHERE type = 'ClockTicked' AND position <= $1", [upTo])
  return rows[0]?.at ?? null
}

export async function loadEventsAfter(q: Queryable, after: number, limit: number): Promise<EventRow[]> {
  const { rows } = await q.query<EventRow>(`SELECT ${EVENT_COLUMNS} FROM events WHERE position > $1 ORDER BY position LIMIT $2`, [after, limit])
  return rows
}

export async function loadEvent(q: Queryable, eventId: string): Promise<EventRow | null> {
  const { rows } = await q.query<EventRow>(`SELECT ${EVENT_COLUMNS} FROM events WHERE event_id = $1`, [eventId])
  return rows[0] ?? null
}

export { EVENT_COLUMNS }
