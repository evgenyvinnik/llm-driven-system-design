/**
 * Streams operations (ops can look, admins can act): lag, pending, staleness, DLQ, redrive, the car
 * registry (registering a car whose fact was dead-lettered) and ETA calibration.
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../../shared/auth.js'
import { pool } from '../../shared/db.js'
import { asyncHandler } from '../../shared/errors.js'
import { listDlq, redrive, streamsOverview } from '../services/streams.js'

export const streamsRouter = Router()
streamsRouter.use(requireAuth, requireRole('ops'))

streamsRouter.get('/overview', asyncHandler(async (_req, res) => res.json(await streamsOverview())))
streamsRouter.get('/dlq', asyncHandler(async (_req, res) => res.json({ entries: await listDlq() })))

streamsRouter.post(
  '/dlq/:group/:entryId/redrive',
  requireRole('admin'),
  asyncHandler(async (req, res) => res.json(await redrive(req.params.group, req.params.entryId))),
)

/** Cars named by events but missing from the registry: what the DLQ is usually waiting for. */
streamsRouter.get(
  '/unknown-cars',
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT ec.car_id, COUNT(*)::int AS events, MIN(e.occurred_at) AS first_seen, array_agg(DISTINCT e.type) AS types
         FROM event_cars ec JOIN events e USING (position) LEFT JOIN cars c ON c.car_id = ec.car_id
        WHERE c.car_id IS NULL GROUP BY ec.car_id ORDER BY ec.car_id`,
    )
    res.json({ cars: rows })
  }),
)

const RegisterCar = z.object({ carId: z.string().regex(/^[A-Z]{2,5}\d{1,6}$/), carType: z.string().min(1).max(20), ownerMark: z.string().min(2).max(4) })

streamsRouter.post(
  '/cars',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const car = RegisterCar.parse(req.body)
    await pool.query('INSERT INTO cars (car_id, car_type, owner_mark) VALUES ($1, $2, $3) ON CONFLICT (car_id) DO NOTHING', [car.carId, car.carType, car.ownerMark])
    res.status(201).json({ car })
  }),
)

/**
 * How good are the ETAs? For delivered cars: the last prediction made at least 24 h (event time) before
 * delivery, whether delivery fell inside its p10–p90 band, and its median error.
 */
streamsRouter.get(
  '/eta-calibration',
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query<{ n: number; inside: number; median_error_h: number | null; early: number; late: number }>(
      `WITH delivered AS (SELECT car_id, p50 AS actual FROM car_eta WHERE final),
            pred AS (
              SELECT DISTINCT ON (h.car_id) h.car_id, h.p10, h.p50, h.p90, d.actual
                FROM eta_history h JOIN delivered d USING (car_id)
               WHERE h.as_of <= d.actual - interval '24 hours'
               ORDER BY h.car_id, h.as_of DESC, h.id DESC)
       SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE actual BETWEEN p10 AND p90)::int AS inside,
              COUNT(*) FILTER (WHERE actual < p10)::int AS early,
              COUNT(*) FILTER (WHERE actual > p90)::int AS late,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(extract(epoch FROM actual - p50)) / 3600) AS median_error_h
         FROM pred`,
    )
    res.json(rows[0])
  }),
)
