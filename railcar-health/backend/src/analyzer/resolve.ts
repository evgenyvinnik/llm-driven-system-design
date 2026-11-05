/**
 * Database side of identity resolution: load a trip's consist, persist AEI
 * corrections, and write the derived car/axle/side columns of a pass's raw
 * readings. Raw columns are never touched, so re-resolving is always safe.
 * @module analyzer/resolve
 */
import type pg from 'pg'
import type { CarEnd, Direction, Rail } from '../shared/domain.js'
import { buildAxleMap, resolveAxle, type ConsistUnit, type Correction } from './identity.js'

export async function loadUnits(client: pg.PoolClient, tripId: string): Promise<ConsistUnit[]> {
  const { rows } = await client.query<{ position: number; unit_id: string; unit_type: 'locomotive' | 'car'; axle_count: number; leading_end: CarEnd }>(
    'SELECT position, unit_id, unit_type, axle_count, leading_end FROM trip_units WHERE trip_id = $1 ORDER BY position',
    [tripId],
  )
  return rows.map((r) => ({ position: r.position, unitId: r.unit_id, unitType: r.unit_type, axleCount: r.axle_count, leadingEnd: r.leading_end }))
}

export async function persistCorrections(client: pg.PoolClient, tripId: string, detectorId: string, corrections: Correction[]): Promise<void> {
  for (const c of corrections) {
    await client.query(
      `UPDATE trip_units SET unit_id = $3, leading_end = $4, orientation_source = 'aei', corrected_by_detector = $5
       WHERE trip_id = $1 AND position = $2`,
      [tripId, c.position, c.unitId, c.leadingEnd, detectorId],
    )
  }
}

/** Writes car_id / car_axle / car_side for every axle of one pass (NULL for locomotives). */
export async function resolvePassReadings(
  client: pg.PoolClient,
  pass: { detectorId: string; passId: string; direction: Direction; axleCount: number },
  units: ConsistUnit[],
): Promise<void> {
  const map = buildAxleMap(units)
  const seqs: number[] = []
  const rails: Rail[] = []
  const carIds: Array<string | null> = []
  const positions: Array<number | null> = []
  const axles: Array<number | null> = []
  const sides: Array<string | null> = []
  for (let seq = 1; seq <= pass.axleCount; seq++) {
    for (const rail of ['N', 'S'] as const) {
      const resolved = resolveAxle(map, seq, rail, pass.direction)
      seqs.push(seq)
      rails.push(rail)
      carIds.push(resolved?.carId ?? null)
      positions.push(resolved?.unitPosition ?? null)
      axles.push(resolved?.carAxle ?? null)
      sides.push(resolved?.carSide ?? null)
    }
  }
  await client.query(
    `UPDATE axle_readings r
        SET car_id = u.car_id, unit_position = u.unit_position, car_axle = u.car_axle, car_side = u.car_side
       FROM unnest($3::int[], $4::text[], $5::text[], $6::int[], $7::int[], $8::text[])
            AS u(axle_seq, rail, car_id, unit_position, car_axle, car_side)
      WHERE r.detector_id = $1 AND r.pass_id = $2 AND r.axle_seq = u.axle_seq AND r.rail = u.rail`,
    [pass.detectorId, pass.passId, seqs, rails, carIds, positions, axles, sides],
  )
  await client.query(
    `UPDATE detector_passes p SET
        median_bearing_n = m.bn, median_bearing_s = m.bs, median_wheel_n = m.wn, median_wheel_s = m.ws
       FROM (
         SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY bearing_f) FILTER (WHERE rail = 'N') AS bn,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY bearing_f) FILTER (WHERE rail = 'S') AS bs,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY wheel_f) FILTER (WHERE rail = 'N') AS wn,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY wheel_f) FILTER (WHERE rail = 'S') AS ws
           FROM axle_readings WHERE detector_id = $1 AND pass_id = $2 AND car_id IS NOT NULL
       ) m
      WHERE p.detector_id = $1 AND p.pass_id = $2`,
    [pass.detectorId, pass.passId],
  )
}

/** After an AEI correction, earlier passes of the trip were mapped with the stale consist: redo them. */
export async function reresolveTrip(client: pg.PoolClient, tripId: string, exceptPass: { detectorId: string; passId: string }, units: ConsistUnit[]): Promise<number> {
  const { rows } = await client.query<{ detector_id: string; pass_id: string; direction: Direction; axle_count: number }>(
    `SELECT detector_id, pass_id, direction, axle_count FROM detector_passes
      WHERE trip_id = $1 AND identity_status = 'resolved' AND NOT (detector_id = $2 AND pass_id = $3)`,
    [tripId, exceptPass.detectorId, exceptPass.passId],
  )
  for (const row of rows) {
    await resolvePassReadings(client, { detectorId: row.detector_id, passId: row.pass_id, direction: row.direction, axleCount: row.axle_count }, units)
  }
  return rows.length
}
