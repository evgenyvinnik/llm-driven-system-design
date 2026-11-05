/**
 * Car view: owner, holds, alerts, the trips it ran (with orientation and how it
 * was known), and per-bearing trends across detectors and trips.
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../../shared/auth.js'
import { clockInfo } from '../../shared/clock.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError, notFound } from '../../shared/errors.js'
import { yardById } from '../../shared/network.js'
import { alertDto, type AlertRow } from '../dto.js'

export const carsRouter = Router()
carsRouter.use(requireAuth)

carsRouter.get(
  '/:carId',
  asyncHandler(async (req, res) => {
    const carId = req.params.carId
    const car = (await pool.query('SELECT car_id, owner_mark, owner_name, car_type, axle_count FROM railcars WHERE car_id = $1', [carId])).rows[0]
    if (!car) throw notFound('Car')
    const [holds, alerts, trips, bearings] = await Promise.all([
      pool.query('SELECT id, alert_id, yard_id, status, reason, created_at, released_at, released_by FROM car_holds WHERE car_id = $1 ORDER BY created_at DESC LIMIT 10', [carId]),
      pool.query<AlertRow>(
        `SELECT a.*, t.symbol, t.direction, t.status AS trip_status FROM alerts a JOIN trips t ON t.trip_id = a.trip_id
          WHERE a.car_id = $1 ORDER BY a.opened_at DESC LIMIT 20`,
        [carId],
      ),
      pool.query(
        `SELECT t.trip_id, t.symbol, t.direction, t.departed_at, t.status, u.position, u.leading_end, u.orientation_source, u.corrected_by_detector
           FROM trip_units u JOIN trips t ON t.trip_id = u.trip_id WHERE u.unit_id = $1 ORDER BY t.departed_at DESC LIMIT 10`,
        [carId],
      ),
      // Each bearing's delta vs the train-side median on the car's most recent trip with readings.
      pool.query(
        `WITH latest AS (
           SELECT p.trip_id FROM axle_readings r JOIN detector_passes p ON p.detector_id = r.detector_id AND p.pass_id = r.pass_id
            WHERE r.car_id = $1 ORDER BY p.passed_at DESC LIMIT 1)
         SELECT r.car_side || r.car_axle AS position, count(*)::int AS observations,
                max(r.bearing_f - CASE r.rail WHEN 'N' THEN p.median_bearing_n ELSE p.median_bearing_s END) AS max_delta,
                (array_agg(r.bearing_f - CASE r.rail WHEN 'N' THEN p.median_bearing_n ELSE p.median_bearing_s END ORDER BY p.passed_at DESC))[1] AS last_delta
           FROM axle_readings r JOIN detector_passes p ON p.detector_id = r.detector_id AND p.pass_id = r.pass_id
          WHERE r.car_id = $1 AND p.trip_id = (SELECT trip_id FROM latest)
          GROUP BY 1`,
        [carId],
      ),
    ])
    res.json({
      car: { carId: car.car_id, ownerMark: car.owner_mark, ownerName: car.owner_name, carType: car.car_type, axleCount: car.axle_count },
      holds: holds.rows.map((h) => ({
        id: h.id, alertId: h.alert_id, yardId: h.yard_id, yardName: yardById(h.yard_id)?.name ?? h.yard_id, status: h.status, reason: h.reason,
        createdAt: h.created_at, releasedAt: h.released_at, releasedBy: h.released_by,
      })),
      alerts: alerts.rows.map(alertDto),
      trips: trips.rows.map((t) => ({
        tripId: t.trip_id, symbol: t.symbol, direction: t.direction, departedAt: t.departed_at, status: t.status, position: t.position,
        leadingEnd: t.leading_end, orientationSource: t.orientation_source, correctedByDetector: t.corrected_by_detector,
      })),
      bearings: bearings.rows.map((b) => ({ position: b.position, observations: b.observations, maxSideDelta: Math.round(b.max_delta), lastSideDelta: Math.round(b.last_delta) })),
      clock: clockInfo(),
    })
  }),
)

const trendSchema = z.object({ position: z.string().regex(/^[LR][1-9]$/) })

carsRouter.get(
  '/:carId/trend',
  asyncHandler(async (req, res) => {
    const parsed = trendSchema.safeParse(req.query)
    if (!parsed.success) throw new HttpError(422, 'VALIDATION_FAILED', 'position must look like R1 or L4')
    const { position } = parsed.data
    const { rows } = await pool.query(
      `SELECT p.trip_id, t.symbol, t.direction, t.departed_at, t.origin_yard_id, p.detector_id, d.milepost, p.passed_at, p.ambient_f, p.lag_seconds,
              r.bearing_f, r.wheel_f, CASE r.rail WHEN 'N' THEN p.median_bearing_n ELSE p.median_bearing_s END AS median_b
         FROM axle_readings r
         JOIN detector_passes p ON p.detector_id = r.detector_id AND p.pass_id = r.pass_id
         JOIN detectors d ON d.id = p.detector_id
         JOIN trips t ON t.trip_id = p.trip_id
        WHERE r.car_id = $1 AND r.car_side = $2 AND r.car_axle = $3
        ORDER BY t.departed_at DESC, p.passed_at`,
      [req.params.carId, position[0], Number(position.slice(1))],
    )
    const series = new Map<string, { tripId: string; symbol: string; direction: string; departedAt: Date; points: unknown[] }>()
    for (const r of rows) {
      if (!series.has(r.trip_id)) {
        if (series.size >= 5) continue
        series.set(r.trip_id, { tripId: r.trip_id, symbol: r.symbol, direction: r.direction, departedAt: r.departed_at, points: [] })
      }
      const originMp = yardById(r.origin_yard_id)?.milepost ?? 0
      series.get(r.trip_id)!.points.push({
        detectorId: r.detector_id, milepost: r.milepost, distance: Math.abs(r.milepost - originMp), passedAt: r.passed_at, lagSeconds: r.lag_seconds,
        aboveAmbient: Math.round((r.bearing_f - r.ambient_f) * 10) / 10,
        sideDelta: r.median_b === null ? null : Math.round((r.bearing_f - r.median_b) * 10) / 10,
      })
    }
    res.json({ carId: req.params.carId, position, series: [...series.values()], clock: clockInfo() })
  }),
)
