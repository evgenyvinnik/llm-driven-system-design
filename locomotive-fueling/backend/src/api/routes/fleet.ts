/**
 * Fleet board and train plan endpoints. Crew sessions are scoped to their one
 * train on every endpoint, including the telemetry history and SSE stream.
 * @module api/routes/fleet
 */
import { Router, type Request } from 'express'
import { z } from 'zod'
import { canSeeTrain, requireAuth, requireRole } from '../../shared/auth.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError, notFound } from '../../shared/errors.js'
import { simNow } from '../../shared/sim-clock.js'
import { enqueuePlan } from '../../shared/triggers.js'
import { acceptPlan, rejectProposal } from '../../planner/acceptance.js'
import { fleetSummaries, trainDetail } from '../services/views.js'

export const fleetRouter = Router()
fleetRouter.use(requireAuth)

fleetRouter.get(
  '/fleet',
  asyncHandler(async (req, res) => {
    const user = req.user!
    const includeArrived = req.query.include === 'arrived'
    const trains = await fleetSummaries(user.role === 'crew' ? (user.trainId ? [user.trainId] : []) : null, includeArrived)
    const [orders, alerts] =
      user.role === 'crew'
        ? [{ rows: [{ n: 0 }] }, { rows: [{ n: trains.reduce((s, t) => s + t.alerts.critical + t.alerts.warning, 0) }] }]
        : await Promise.all([
            pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM dtl_orders WHERE status IN ('pending', 'unknown', 'confirmed', 'cancel_requested')`),
            pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM alerts WHERE status = 'open'`),
          ])
    const running = trains.filter((t) => t.status === 'running')
    res.json({
      simNow: (await simNow()).getTime(),
      trains,
      summary: {
        running: running.length,
        openAlerts: alerts.rows[0].n,
        activeOrders: orders.rows[0].n,
        plannedFuelCost: Math.round(running.reduce((s, t) => s + (t.plan?.purchaseCost ?? 0), 0)),
        lowestFuelPct: Math.min(...running.flatMap((t) => t.units.map((u) => u.fuelPct ?? 100)), 100),
      },
    })
  }),
)

function checkTrain(req: Request) {
  if (!canSeeTrain(req.user!, String(req.params.id))) throw new HttpError(403, 'FORBIDDEN', 'Crew can only view their own train')
}

fleetRouter.get(
  '/trains/:id',
  asyncHandler(async (req, res) => {
    checkTrain(req)
    const detail = await trainDetail(req.params.id)
    if (!detail) throw notFound('Train')
    res.json({ ...detail, simNow: (await simNow()).getTime() })
  }),
)

fleetRouter.get(
  '/trains/:id/plans/:version',
  asyncHandler(async (req, res) => {
    checkTrain(req)
    const version = z.coerce.number().int().positive().parse(req.params.version)
    const { rows } = await pool.query(
      `SELECT p.version, p.status, p.trigger, p.reason, p.created_at AS "createdAt", p.milepost, p.cost_total::float AS "costTotal",
              p.cost_breakdown AS "costBreakdown", p.greedy_cost::float AS "greedyCost", p.inputs, p.profile,
              COALESCE((SELECT json_agg(json_build_object('seq', s.seq, 'locationId', s.location_id, 'optionId', s.option_id, 'kind', s.kind,
                 'gallons', s.gallons, 'etaMs', extract(epoch from s.eta) * 1000, 'perUnit', s.per_unit, 'fuelCost', s.fuel_cost::float) ORDER BY s.seq)
                 FROM plan_stops s WHERE s.plan_id = p.id), '[]') AS stops
         FROM fuel_plans p WHERE p.train_id = $1 AND p.version = $2`,
      [req.params.id, version],
    )
    if (!rows[0]) throw notFound('Plan version')
    res.json(rows[0])
  }),
)

/** Raw vs smoothed fuel for each unit: the evidence behind sensor and leak alerts. */
fleetRouter.get(
  '/trains/:id/telemetry',
  asyncHandler(async (req, res) => {
    checkTrain(req)
    const limit = z.coerce.number().int().min(10).max(600).default(240).parse(req.query.limit)
    const { rows } = await pool.query(
      `SELECT locomotive_id AS "locomotiveId", seq, extract(epoch from recorded_at) * 1000 AS t, milepost, speed_mph AS speed, notch,
              fuel_raw AS raw, fuel_smoothed AS smoothed, late
         FROM (SELECT * FROM telemetry WHERE train_id = $1 ORDER BY recorded_at DESC LIMIT $2) x
        ORDER BY recorded_at`,
      [req.params.id, limit * 4],
    )
    res.json({ readings: rows.map((r) => ({ ...r, t: Number(r.t) })) })
  }),
)

fleetRouter.post(
  '/trains/:id/replan',
  requireRole('fuel_desk'),
  asyncHandler(async (req, res) => {
    await enqueuePlan(req.params.id, 'manual', `requested by ${req.user!.username}`)
    res.status(202).json({ queued: true })
  }),
)

/** Accept the current recommendation: fuel desk for any train, crew for their own. */
fleetRouter.post(
  '/trains/:id/plans/:version/accept',
  requireRole('fuel_desk', 'crew'),
  asyncHandler(async (req, res) => {
    checkTrain(req)
    const version = z.coerce.number().int().positive().parse(req.params.version)
    res.json(await acceptPlan(String(req.params.id), version, `${req.user!.username} (${req.user!.role.replace('_', ' ')})`, 'accept'))
  }),
)

/** Confirm a change proposed after acceptance. Fuel desk only: it changes what the crew was told. */
fleetRouter.post(
  '/trains/:id/plans/:version/confirm',
  requireRole('fuel_desk'),
  asyncHandler(async (req, res) => {
    const version = z.coerce.number().int().positive().parse(req.params.version)
    res.json(await acceptPlan(String(req.params.id), version, `${req.user!.username} (fuel desk)`, 'confirm'))
  }),
)

fleetRouter.post(
  '/trains/:id/plans/:version/reject',
  requireRole('fuel_desk'),
  asyncHandler(async (req, res) => {
    const version = z.coerce.number().int().positive().parse(req.params.version)
    await rejectProposal(String(req.params.id), version, req.user!.username)
    res.json({ rejected: version })
  }),
)
