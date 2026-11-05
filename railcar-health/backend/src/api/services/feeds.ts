/**
 * Non-detector feeds: gateway heartbeats, consists from the transportation
 * system, and departure/arrival events. All idempotent.
 * @module api/services/feeds
 */
import type { Redis } from 'ioredis'
import { z } from 'zod'
import { pool, withTransaction } from '../../shared/db.js'
import { HttpError } from '../../shared/errors.js'
import { yardById } from '../../shared/network.js'
import { publishAll } from './ingest.js'

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

export async function upsertConsist(input: z.infer<typeof consistSchema>, streamClient: Redis): Promise<{ status: 'created' | 'updated' | 'unchanged'; republished: number }> {
  if (!yardById(input.originYardId) || !yardById(input.destinationYardId)) throw new HttpError(422, 'UNKNOWN_YARD', 'Unknown origin or destination yard')
  const status = await withTransaction(async (client) => {
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
       ON CONFLICT (trip_id) DO UPDATE SET consist_revision = EXCLUDED.consist_revision, stops = EXCLUDED.stops, updated_at = now()
         WHERE trips.consist_revision < EXCLUDED.consist_revision
       RETURNING (xmax = 0) AS inserted`,
      [input.tripId, input.symbol, input.direction, input.originYardId, input.destinationYardId, input.stops, input.departedAt, input.revision],
    )
    if (res.rowCount === 0) return 'unchanged' as const
    await client.query('DELETE FROM trip_units WHERE trip_id = $1', [input.tripId])
    const u = input.units
    await client.query(
      `INSERT INTO trip_units (trip_id, position, unit_id, unit_type, axle_count, leading_end, loaded)
       SELECT $1, * FROM unnest($2::int[], $3::text[], $4::text[], $5::int[], $6::text[], $7::bool[])`,
      [input.tripId, u.map((x) => x.position), u.map((x) => x.unitId), u.map((x) => x.unitType), u.map((x) => x.axleCount), u.map((x) => x.leadingEnd), u.map((x) => x.loaded)],
    )
    return res.rows[0].inserted ? ('created' as const) : ('updated' as const)
  })
  // Passes that arrived before this consist were parked; send them back through the analyzer.
  const parked = await pool.query<{ detector_id: string; pass_id: string }>(
    `UPDATE detector_passes SET identity_status = 'pending' WHERE trip_id = $1 AND identity_status = 'awaiting_consist' RETURNING detector_id, pass_id`,
    [input.tripId],
  )
  await publishAll(streamClient, parked.rows.map((r) => ({ detectorId: r.detector_id, passId: r.pass_id })))
  return { status, republished: parked.rowCount ?? 0 }
}

export async function recordTripEvent(input: z.infer<typeof tripEventSchema>): Promise<'recorded' | 'duplicate'> {
  const yard = yardById(input.yardId)
  if (!yard) throw new HttpError(422, 'UNKNOWN_YARD', 'Unknown yard')
  return withTransaction(async (client) => {
    const trip = await client.query('SELECT 1 FROM trips WHERE trip_id = $1', [input.tripId])
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
    }
    return 'recorded' as const
  })
}
