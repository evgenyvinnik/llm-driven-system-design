/**
 * Trains (trips): list, detail with consist and passes, and the axle-by-detector heatmap.
 */
import { Router } from 'express'
import { requireAuth } from '../../shared/auth.js'
import { config } from '../../shared/config.js'
import { clockInfo } from '../../shared/clock.js'
import { pool } from '../../shared/db.js'
import type { CarEnd, Direction } from '../../shared/domain.js'
import { asyncHandler, notFound } from '../../shared/errors.js'
import { detectorViewOf } from '../../shared/geometry.js'
import { loadThresholds } from '../../shared/thresholds.js'
import { tripDto, type TripRow } from '../dto.js'

export const tripsRouter = Router()
tripsRouter.use(requireAuth)

tripsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query<TripRow>(
      `SELECT t.*,
              (SELECT count(*)::int FROM trip_units u WHERE u.trip_id = t.trip_id AND u.unit_type = 'car') AS car_count,
              (SELECT count(*)::int FROM alerts a WHERE a.trip_id = t.trip_id AND a.status <> 'closed') AS open_alerts,
              (SELECT max(tier) FROM alerts a WHERE a.trip_id = t.trip_id AND a.status <> 'closed') AS max_tier
         FROM trips t
        WHERE EXISTS (SELECT 1 FROM detector_passes p WHERE p.trip_id = t.trip_id) OR t.status = 'en_route'
        ORDER BY (t.status = 'arrived'), t.departed_at DESC LIMIT 50`,
    )
    res.json({ trips: rows.map(tripDto), clock: clockInfo() })
  }),
)

async function loadTrip(tripId: string): Promise<TripRow> {
  const { rows } = await pool.query<TripRow>(
    `SELECT t.*, (SELECT count(*)::int FROM trip_units u WHERE u.trip_id = t.trip_id AND u.unit_type = 'car') AS car_count
       FROM trips t WHERE t.trip_id = $1`,
    [tripId],
  )
  if (!rows[0]) throw notFound('Train')
  return rows[0]
}

tripsRouter.get(
  '/:tripId',
  asyncHandler(async (req, res) => {
    const trip = await loadTrip(req.params.tripId)
    const [units, passes] = await Promise.all([
      pool.query(
        `SELECT u.position, u.unit_id, u.unit_type, u.axle_count, u.leading_end, u.orientation_source, u.corrected_by_detector, c.owner_mark, c.car_type
           FROM trip_units u LEFT JOIN railcars c ON c.car_id = u.unit_id WHERE u.trip_id = $1 ORDER BY u.position`,
        [trip.trip_id],
      ),
      pool.query(
        `SELECT p.detector_id, p.pass_id, p.passed_at, p.received_at, p.lag_seconds, p.ambient_f, p.speed_mph, p.identity_status, p.aei IS NOT NULL AS has_aei,
                p.edge_alarms, d.name, d.milepost, d.status AS detector_status
           FROM detector_passes p JOIN detectors d ON d.id = p.detector_id WHERE p.trip_id = $1 ORDER BY p.passed_at`,
        [trip.trip_id],
      ),
    ])
    res.json({
      trip: tripDto(trip),
      units: units.rows.map((u) => ({
        position: u.position, unitId: u.unit_id, unitType: u.unit_type, axleCount: u.axle_count, leadingEnd: u.leading_end,
        orientationSource: u.orientation_source, correctedByDetector: u.corrected_by_detector, ownerMark: u.owner_mark, carType: u.car_type,
      })),
      passes: passes.rows.map((p) => ({
        detectorId: p.detector_id, passId: p.pass_id, name: p.name, milepost: p.milepost, passedAt: p.passed_at, receivedAt: p.received_at,
        lagSeconds: p.lag_seconds, late: p.lag_seconds > config.analysis.lateAfterMinutes * 60, ambientF: p.ambient_f, speedMph: p.speed_mph,
        identityStatus: p.identity_status, hasAei: p.has_aei, edgeAlarms: p.edge_alarms ?? [], detectorStatus: p.detector_status,
      })),
      clock: clockInfo(),
    })
  }),
)

/**
 * Heatmap data: one row per (pass, rail), one column per car axle in train
 * order, value = bearing temperature. The client derives above-ambient and
 * delta-vs-median from the ambient and the per-rail medians returned here.
 */
tripsRouter.get(
  '/:tripId/heatmap',
  asyncHandler(async (req, res) => {
    const trip = await loadTrip(req.params.tripId)
    const { config: t } = await loadThresholds()
    const units = (
      await pool.query<{ position: number; unit_id: string; unit_type: string; axle_count: number; leading_end: CarEnd }>(
        'SELECT position, unit_id, unit_type, axle_count, leading_end FROM trip_units WHERE trip_id = $1 ORDER BY position',
        [trip.trip_id],
      )
    ).rows
    // Columns: car axles only, with their train-relative sequence number.
    const columns: Array<{ seq: number; carId: string; carIndex: number; seqInCar: number }> = []
    const firstSeq = new Map<string, number>()
    let seq = 0
    let carIndex = 0
    for (const u of units) {
      if (u.unit_type === 'car') {
        carIndex += 1
        firstSeq.set(u.unit_id, seq + 1)
      }
      for (let i = 1; i <= u.axle_count; i++) {
        seq += 1
        if (u.unit_type === 'car') columns.push({ seq, carId: u.unit_id, carIndex, seqInCar: i })
      }
    }
    const colIndex = new Map(columns.map((c, i) => [c.seq, i]))
    const passes = (
      await pool.query(
        `SELECT p.detector_id, p.pass_id, p.passed_at, p.lag_seconds, p.ambient_f, p.median_bearing_n, p.median_bearing_s,
                d.name, d.milepost, d.bias_offset_f, d.bias_samples
           FROM detector_passes p JOIN detectors d ON d.id = p.detector_id
          WHERE p.trip_id = $1 AND p.identity_status = 'resolved' ORDER BY p.passed_at`,
        [trip.trip_id],
      )
    ).rows
    const readings = (
      await pool.query<{ detector_id: string; pass_id: string; axle_seq: number; rail: 'N' | 'S'; bearing_f: number }>(
        `SELECT r.detector_id, r.pass_id, r.axle_seq, r.rail, r.bearing_f FROM axle_readings r
           JOIN detector_passes p ON p.detector_id = r.detector_id AND p.pass_id = r.pass_id
          WHERE p.trip_id = $1 AND p.identity_status = 'resolved' AND r.car_id IS NOT NULL`,
        [trip.trip_id],
      )
    ).rows
    const values = new Map<string, { N: Array<number | null>; S: Array<number | null> }>()
    for (const p of passes) values.set(`${p.detector_id}|${p.pass_id}`, { N: columns.map(() => null), S: columns.map(() => null) })
    for (const r of readings) {
      const idx = colIndex.get(r.axle_seq)
      const row = values.get(`${r.detector_id}|${r.pass_id}`)
      if (idx !== undefined && row) row[r.rail][idx] = r.bearing_f
    }
    // Where each open alert's bearing shows up in the grid, given the car's (corrected) orientation.
    const alerts = (
      await pool.query<{ id: string; car_id: string; position: string; tier: number; kind: string }>(
        `SELECT id, car_id, position, tier, kind FROM alerts WHERE trip_id = $1 AND status <> 'closed' ORDER BY tier DESC`,
        [trip.trip_id],
      )
    ).rows
    const highlights = alerts.flatMap((a): Array<Record<string, unknown>> => {
      const unit = units.find((u) => u.unit_id === a.car_id)
      const start = firstSeq.get(a.car_id)
      if (!unit || start === undefined) return []
      const base = { alertId: a.id, carId: a.car_id, position: a.position, tier: a.tier, kind: a.kind }
      // Wheel alerts cover the whole car: highlight all its axles on both rails.
      if (!/^[LR]\d$/.test(a.position)) return [{ ...base, column: colIndex.get(start) ?? -1, span: unit.axle_count, rail: null }]
      const view = detectorViewOf(a.position[0] as 'L' | 'R', Number(a.position.slice(1)), trip.direction as Direction, unit.leading_end, unit.axle_count)
      return [{ ...base, column: colIndex.get(start + view.seqInCar - 1) ?? -1, span: 1, rail: view.rail }]
    })
    res.json({
      tripId: trip.trip_id,
      direction: trip.direction,
      columns,
      passes: passes.map((p) => {
        const flagged = p.bias_offset_f !== null && p.bias_samples >= t.biasMinSamples && Math.abs(p.bias_offset_f) >= t.biasAlarmF
        return {
          detectorId: p.detector_id, passId: p.pass_id, name: p.name, milepost: p.milepost, passedAt: p.passed_at, lagSeconds: p.lag_seconds,
          late: p.lag_seconds > config.analysis.lateAfterMinutes * 60, ambientF: p.ambient_f,
          medians: { N: p.median_bearing_n, S: p.median_bearing_s }, biasOffsetF: flagged ? p.bias_offset_f : null,
          values: values.get(`${p.detector_id}|${p.pass_id}`),
        }
      }),
      highlights,
    })
  }),
)
