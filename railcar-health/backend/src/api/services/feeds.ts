/**
 * Non-detector feeds: gateway heartbeats, consists from the transportation
 * system, and departure/arrival events. All idempotent.
 *
 * Trips and consists are state with an outbox: the trips / trip_units rows are
 * the source of truth and ConsistVersionChanged / TripArrived are appended in
 * the same transaction. Heartbeats are telemetry and produce no event; a
 * detector's decided status does (DetectorHealthChanged, from the analyzer).
 * @module api/services/feeds
 */
import { z } from 'zod'
import { pool } from '../../shared/db.js'
import { HttpError } from '../../shared/errors.js'
import { yardById } from '../../shared/network.js'
import { streamIds } from '../../events/catalog.js'
import { withEventTransaction } from '../../events/store.js'

const isoDate = z.string().datetime({ offset: true })

export const heartbeatSchema = z.object({
  heartbeats: z
    .array(z.object({ detectorId: z.string().min(1), gatewayId: z.string().min(1), sentAt: isoDate, bufferedPasses: z.number().int().min(0), selfTest: z.enum(['ok', 'fault']) }))
    .min(1)
    .max(200),
})

export const consistSchema = z.object({
  tripId: z.string().min(1).max(64),
  symbol: z.string().min(1).max(32),
  direction: z.enum(['EB', 'WB']),
  originYardId: z.string(),
  destinationYardId: z.string(),
  stops: z.array(z.string()).min(1),
  departedAt: isoDate,
  revision: z.number().int().min(1).default(1),
  /** When this revision took effect (e.g. departure from the yard where the train was rebuilt). Defaults to departure. */
  effectiveAt: isoDate.optional(),
  units: z
    .array(
      z.object({
        position: z.number().int().min(1),
        unitId: z.string().min(1).max(32),
        unitType: z.enum(['locomotive', 'car']),
        axleCount: z.number().int().min(2).max(12),
        leadingEnd: z.enum(['A', 'B']),
        loaded: z.boolean().default(true),
        ownerMark: z.string().max(8).optional(),
        ownerName: z.string().max(80).optional(),
        carType: z.string().max(40).optional(),
      }),
    )
    .min(1)
    .max(500),
})

export const tripEventSchema = z.object({
  eventId: z.string().min(1).max(100),
  tripId: z.string().min(1),
  kind: z.enum(['departed', 'arrived']),
  yardId: z.string(),
  at: isoDate,
})

export async function recordHeartbeats(input: z.infer<typeof heartbeatSchema>): Promise<number> {
  let updated = 0
  for (const hb of input.heartbeats) {
    // Only the newest heartbeat may set the buffered count; an old one delivered late changes nothing.
    const res = await pool.query(
      `UPDATE detectors SET
          buffered_passes = CASE WHEN last_heard_at IS NULL OR $2 >= last_heard_at THEN $3 ELSE buffered_passes END,
          self_test       = CASE WHEN last_heard_at IS NULL OR $2 >= last_heard_at THEN $4 ELSE self_test END,
          last_heard_at   = GREATEST(COALESCE(last_heard_at, $2), $2)
        WHERE id = $1`,
      [hb.detectorId, hb.sentAt, hb.bufferedPasses, hb.selfTest],
    )
    updated += res.rowCount ?? 0
  }
  return updated
}

export async function upsertConsist(input: z.infer<typeof consistSchema>): Promise<{ status: 'created' | 'updated' | 'unchanged' }> {
  if (!yardById(input.originYardId) || !yardById(input.destinationYardId)) throw new HttpError(422, 'UNKNOWN_YARD', 'Unknown origin or destination yard')
  const ctx = { correlationId: `consist:${input.tripId}:${input.revision}`, actor: 'transportation-system' }
  const { result } = await withEventTransaction(ctx, async ({ client, batch }) => {
    // Same per-trip lock as the analyzer: a pass parked for want of this consist is either parked
    // before we commit (and released by ConsistVersionChanged) or sees the trip after we commit.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.tripId])
    const cars = input.units.filter((u) => u.unitType === 'car')
    if (cars.length > 0) {
      await client.query(
        `INSERT INTO railcars (car_id, owner_mark, owner_name, car_type, axle_count)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[]) ON CONFLICT (car_id) DO NOTHING`,
        [cars.map((c) => c.unitId), cars.map((c) => c.ownerMark ?? c.unitId.split(' ')[0]), cars.map((c) => c.ownerName ?? 'Unknown owner'),
          cars.map((c) => c.carType ?? 'unknown'), cars.map((c) => c.axleCount)],
      )
    }
    const res = await client.query<{ inserted: boolean }>(
      `INSERT INTO trips (trip_id, symbol, direction, origin_yard_id, destination_yard_id, stops, departed_at, consist_revision, territory_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, (SELECT subdivision_id FROM yards WHERE id = $4))
       ON CONFLICT (trip_id) DO UPDATE SET consist_revision = GREATEST(trips.consist_revision, EXCLUDED.consist_revision), updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [input.tripId, input.symbol, input.direction, input.originYardId, input.destinationYardId, input.stops, input.departedAt, input.revision],
    )
    // Revisions are immutable: a repeat of a known revision changes nothing and emits nothing.
    const effectiveAt = input.effectiveAt ?? input.departedAt
    const version = await client.query(
      `INSERT INTO trip_consist_versions (trip_id, revision, effective_at) VALUES ($1, $2, $3) ON CONFLICT (trip_id, revision) DO NOTHING`,
      [input.tripId, input.revision, effectiveAt],
    )
    if (version.rowCount === 0) return 'unchanged' as const
    const u = input.units
    await client.query(
      `INSERT INTO trip_units (trip_id, revision, position, unit_id, unit_type, axle_count, leading_end, loaded)
       SELECT $1, $2, * FROM unnest($3::int[], $4::text[], $5::text[], $6::int[], $7::text[], $8::bool[])`,
      [input.tripId, input.revision, u.map((x) => x.position), u.map((x) => x.unitId), u.map((x) => x.unitType), u.map((x) => x.axleCount), u.map((x) => x.leadingEnd), u.map((x) => x.loaded)],
    )
    // A rebuilt consist comes from yard records, which may repeat a stale orientation an AEI read already corrected.
    await client.query(
      `UPDATE trip_units n SET leading_end = o.leading_end, orientation_source = 'aei', corrected_by_detector = o.corrected_by_detector
         FROM trip_units o
        WHERE n.trip_id = $1 AND n.revision = $2 AND o.trip_id = $1 AND o.revision < $2 AND o.unit_id = n.unit_id AND o.orientation_source = 'aei'`,
      [input.tripId, input.revision],
    )
    const previous = await client.query<{ unit_id: string }>('SELECT unit_id FROM trip_units WHERE trip_id = $1 AND revision = $2', [input.tripId, input.revision - 1])
    const before = new Set(previous.rows.map((r) => r.unit_id))
    const after = new Set(u.map((x) => x.unitId))
    batch.append(streamIds.trip(input.tripId), 'any', {
      type: 'ConsistVersionChanged',
      occurredAt: effectiveAt,
      tags: [`trip:${input.tripId}`],
      payload: {
        tripId: input.tripId, symbol: input.symbol, direction: input.direction, originYardId: input.originYardId, destinationYardId: input.destinationYardId,
        stops: input.stops, departedAt: input.departedAt, revision: input.revision, effectiveAt,
        units: u.map((x) => ({ position: x.position, unitId: x.unitId, unitType: x.unitType, axleCount: x.axleCount, leadingEnd: x.leadingEnd })),
        setOut: input.revision > 1 ? [...before].filter((id) => !after.has(id)) : [],
        pickedUp: input.revision > 1 ? [...after].filter((id) => !before.has(id)) : [],
      },
    })
    return res.rows[0].inserted ? ('created' as const) : ('updated' as const)
  })
  return { status: result }
}

export async function recordTripEvent(input: z.infer<typeof tripEventSchema>): Promise<'recorded' | 'duplicate'> {
  const yard = yardById(input.yardId)
  if (!yard) throw new HttpError(422, 'UNKNOWN_YARD', 'Unknown yard')
  const { result } = await withEventTransaction({ correlationId: `trip-event:${input.eventId}`, actor: 'transportation-system' }, async ({ client, batch }) => {
    const trip = await client.query<{ symbol: string }>('SELECT symbol FROM trips WHERE trip_id = $1', [input.tripId])
    if (trip.rowCount === 0) throw new HttpError(404, 'NOT_FOUND', 'Trip not found')
    const res = await client.query(
      'INSERT INTO trip_events (event_id, trip_id, kind, yard_id, at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (event_id) DO NOTHING',
      [input.eventId, input.tripId, input.kind, input.yardId, input.at],
    )
    if (res.rowCount === 0) return 'duplicate' as const
    if (input.kind === 'arrived') {
      await client.query(
        `UPDATE trips SET status = 'arrived', arrived_at = $2, arrived_yard_id = $3, territory_id = $4, next_yard_id = NULL, next_yard_eta = NULL, updated_at = now()
          WHERE trip_id = $1`,
        [input.tripId, input.at, input.yardId, yard.subdivisionId],
      )
      // The random audit inspection is opened by the work-order integration reacting to this event (choreography).
      batch.append(streamIds.trip(input.tripId), 'any', {
        type: 'TripArrived',
        occurredAt: input.at,
        tags: [`trip:${input.tripId}`],
        payload: { tripId: input.tripId, symbol: trip.rows[0].symbol, yardId: input.yardId, arrivedAt: new Date(input.at).toISOString() },
      })
    }
    return 'recorded' as const
  })
  return result
}
