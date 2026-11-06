/**
 * Operations: the exceptions board, replanning sagas, train runs, trip plans (with manual revision under
 * optimistic concurrency) and digests. Shippers may read their own exceptions, plans and digests.
 */
import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { requireAuth, requireRole, shipperScope, canSeeShipper } from '../../shared/auth.js'
import { pool, withTransaction } from '../../shared/db.js'
import { asyncHandler, HttpError, notFound } from '../../shared/errors.js'
import { ConcurrencyError } from '../../shared/event-store.js'
import { loadPlan, reserveFirstRun, revisePlan } from '../../shared/plans.js'
import { resolveException } from '../../consumers/exceptions/handler.js'
import { materializeRuns } from '../../shared/network.js'
import { nowMs } from '../../shared/clock.js'

export const opsRouter = Router()
opsRouter.use(requireAuth)

// ── Exceptions ──

opsRouter.get(
  '/exceptions',
  asyncHandler(async (req, res) => {
    const scope = shipperScope(req.user!)
    const status = (req.query.status as string) || 'open'
    const type = (req.query.type as string) || null
    const { rows } = await pool.query(
      `SELECT x.*, s.name AS shipper_name, cs.status AS car_status, cs.location_id AS car_location, ce.p50 AS eta_p50, ce.p90 AS eta_p90
         FROM exceptions x LEFT JOIN shippers s ON s.shipper_id = x.shipper_id
         LEFT JOIN car_state cs ON cs.car_id = x.car_id LEFT JOIN car_eta ce ON ce.car_id = x.car_id
        WHERE ($1::text IS NULL OR x.shipper_id = $1) AND ($2 = 'all' OR x.status = $2) AND ($3::text IS NULL OR x.type = $3)
        ORDER BY CASE x.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, x.opened_at DESC LIMIT 400`,
      [scope, status, type],
    )
    const { rows: counts } = await pool.query<{ type: string; status: string; n: number }>(
      'SELECT type, status, COUNT(*)::int AS n FROM exceptions WHERE ($1::text IS NULL OR shipper_id = $1) GROUP BY type, status',
      [scope],
    )
    res.json({ exceptions: rows, counts })
  }),
)

const Resolve = z.object({ version: z.number().int().min(1), note: z.string().min(1).max(200) })

opsRouter.post(
  '/exceptions/:id/resolve',
  requireRole('ops'),
  asyncHandler(async (req, res) => {
    const { version, note } = Resolve.parse(req.body)
    const { rows } = await pool.query<{ car_id: string; status: string; version: number }>('SELECT car_id, status, version FROM exceptions WHERE exception_id = $1', [req.params.id])
    const ex = rows[0]
    if (!ex) throw notFound('Exception')
    if (ex.status !== 'open' || ex.version !== version) throw new HttpError(409, 'VERSION_CONFLICT', 'The exception changed since you loaded it', { status: ex.status, version: ex.version })
    try {
      // Stream exception-<id> holds ExceptionOpened (v1); resolving appends v2 only if nobody else did.
      const result = await withTransaction((tx) => resolveException(tx, null, req.params.id, ex.car_id, note, req.user!.username, 1))
      res.status(202).json({ eventId: result.eventId, status: result.status, note: 'Applied to the board when the exceptions consumer processes it' })
    } catch (err) {
      if (err instanceof ConcurrencyError) throw new HttpError(409, 'VERSION_CONFLICT', 'Already resolved', { actual: err.actual })
      throw err
    }
  }),
)

// ── Replanning sagas ──

opsRouter.get(
  '/replans',
  requireRole('ops'),
  asyncHandler(async (req, res) => {
    const state = (req.query.state as string) || null
    const { rows } = await pool.query(
      `SELECT r.*, s.name AS shipper_name FROM replan_sagas r LEFT JOIN shippers s ON s.shipper_id = r.shipper_id
        WHERE ($1::text IS NULL OR r.state = $1) ORDER BY r.created_at DESC LIMIT 300`,
      [state],
    )
    const { rows: counts } = await pool.query<{ state: string; n: number }>('SELECT state, COUNT(*)::int AS n FROM replan_sagas GROUP BY state')
    res.json({ sagas: rows, counts: Object.fromEntries(counts.map((c) => [c.state, c.n])) })
  }),
)

// ── Train runs ──

opsRouter.get(
  '/trains/runs',
  requireRole('ops'),
  asyncHandler(async (req, res) => {
    const now = nowMs()
    const from = req.query.from ? Date.parse(req.query.from as string) : now - 4 * 86_400_000
    const to = req.query.to ? Date.parse(req.query.to as string) : now + 2 * 86_400_000
    await materializeRuns(pool, from, to)
    const { rows } = await pool.query(
      `SELECT r.run_id, r.train_id, r.from_yard, r.to_yard, r.scheduled_departure, r.scheduled_arrival, r.capacity,
              (SELECT COUNT(*)::int FROM run_reservations rr WHERE rr.run_id = r.run_id) AS reserved,
              (SELECT COUNT(*)::int FROM train_run_cars c WHERE c.run_id = r.run_id) AS consist_size,
              (SELECT MAX(occurred_at) FROM events e WHERE e.stream_id = 'train-' || r.run_id AND e.type = 'TrainDeparted') AS departed_at,
              (SELECT MAX(occurred_at) FROM events e WHERE e.stream_id = 'train-' || r.run_id AND e.type = 'TrainArrived') AS arrived_at,
              (SELECT MAX((payload->>'delayMinutes')::int) FROM events e WHERE e.stream_id = 'train-' || r.run_id AND e.type = 'TrainDelayed') AS delay_minutes,
              EXISTS (SELECT 1 FROM events e WHERE e.stream_id = 'train-' || r.run_id AND e.type = 'TrainCancelled') AS cancelled
         FROM train_runs r WHERE r.scheduled_departure BETWEEN $1 AND $2 ORDER BY r.scheduled_departure`,
      [new Date(from).toISOString(), new Date(to).toISOString()],
    )
    res.json({ runs: rows })
  }),
)

/** Cars whose current plan puts them on a run (the yard builds the train from this list). */
opsRouter.get(
  '/trains/runs/:runId/planned',
  requireRole('ops'),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT trip_id, car_id, plan_version, leg_seq, from_yard, to_yard FROM plan_legs_current WHERE run_id = $1 ORDER BY car_id',
      [req.params.runId],
    )
    res.json({ runId: req.params.runId, cars: rows })
  }),
)

// ── Trip plans ──

opsRouter.get(
  '/trips/:tripId',
  asyncHandler(async (req, res) => {
    const plan = await loadPlan(pool, req.params.tripId)
    if (!plan || !canSeeShipper(req.user!, plan.shipperId)) throw notFound('Trip')
    res.json({ plan })
  }),
)

const Revise = z.object({ expectedVersion: z.number().int().min(1), legSeq: z.number().int().min(0), runId: z.string().min(1).max(40), note: z.string().min(1).max(200) })

/** Manual revision by an operator: move one leg to a named run. 409 if the plan moved on meanwhile. */
opsRouter.post(
  '/trips/:tripId/revise',
  requireRole('ops'),
  asyncHandler(async (req, res) => {
    const input = Revise.parse(req.body)
    const result = await withTransaction(async (tx) => {
      const plan = await loadPlan(tx, req.params.tripId)
      if (!plan) throw notFound('Trip')
      if (plan.version !== input.expectedVersion) throw new HttpError(409, 'VERSION_CONFLICT', `Plan is at v${plan.version}`, { version: plan.version })
      const leg = plan.legs.find((l) => l.seq === input.legSeq)
      if (!leg) throw new HttpError(422, 'BAD_LEG', 'No such leg')
      const { rows } = await tx.query<{ train_id: string; from_yard: string; to_yard: string; scheduled_departure: Date }>('SELECT train_id, from_yard, to_yard, scheduled_departure FROM train_runs WHERE run_id = $1', [input.runId])
      const run = rows[0]
      if (!run || run.from_yard !== leg.fromYard || run.to_yard !== leg.toYard) throw new HttpError(422, 'BAD_RUN', 'Run does not serve this leg')
      const seat = await reserveFirstRun(tx, [run.train_id], run.scheduled_departure.getTime(), plan.tripId, `ops:${req.user!.username}`, 1)
      if (!seat || seat.runId !== input.runId) throw new HttpError(409, 'NO_CAPACITY', 'That run is full, cancelled or gone')
      const legs = plan.legs.map((l) => (l.seq === input.legSeq ? { ...l, trainId: seat.trainId, runId: seat.runId, plannedDeparture: seat.departure, plannedArrival: seat.arrival } : l))
      try {
        return await revisePlan(tx, plan, {
          tripId: plan.tripId, expectedVersion: input.expectedVersion, legs, reason: { code: 'manual', text: input.note, missedRunId: leg.runId, yardId: leg.fromYard },
          revisedBy: req.user!.username, sagaId: null, producer: `ops:${req.user!.username}`, correlationId: randomUUID(), causationId: null,
        })
      } catch (err) {
        if (err instanceof ConcurrencyError) throw new HttpError(409, 'VERSION_CONFLICT', `Plan is at v${err.actual}`, { version: err.actual })
        throw err
      }
    })
    res.status(201).json(result)
  }),
)

// ── Digests ──

opsRouter.get(
  '/notifications',
  asyncHandler(async (req, res) => {
    const scope = shipperScope(req.user!) ?? ((req.query.shipper as string) || null)
    const { rows } = await pool.query(
      `SELECT d.*, s.name AS shipper_name FROM digests d JOIN shippers s USING (shipper_id)
        WHERE ($1::text IS NULL OR d.shipper_id = $1) ORDER BY d.created_at DESC LIMIT 200`,
      [scope],
    )
    const { rows: pending } = await pool.query<{ shipper_id: string; n: number }>(
      'SELECT shipper_id, COUNT(*)::int AS n FROM notification_items WHERE digest_id IS NULL AND ($1::text IS NULL OR shipper_id = $1) GROUP BY shipper_id',
      [scope],
    )
    const { rows: totals } = await pool.query<{ items: number; digests: number; suppressed: number }>(
      `SELECT (SELECT COUNT(*)::int FROM notification_items WHERE ($1::text IS NULL OR shipper_id = $1)) AS items,
              (SELECT COUNT(*)::int FROM digests WHERE ($1::text IS NULL OR shipper_id = $1)) AS digests,
              (SELECT COUNT(*)::int FROM notification_items WHERE digest_id = 'suppressed' AND ($1::text IS NULL OR shipper_id = $1)) AS suppressed`,
      [scope],
    )
    res.json({ digests: rows, pending, totals: totals[0] })
  }),
)
