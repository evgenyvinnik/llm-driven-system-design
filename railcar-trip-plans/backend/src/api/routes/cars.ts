/**
 * Car reads: the shipper portal list, the car detail (plan versions, ETA, exceptions, replans) and the car's
 * event timeline with causation chains. Every query is scoped by the session: a shipper's filter comes
 * from the session, never from the request, and a car that is not theirs is reported as not found.
 */
import { Router } from 'express'
import { canSeeShipper, requireAuth, shipperScope, type SessionUser } from '../../shared/auth.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, notFound } from '../../shared/errors.js'
import { loadCarTimeline, loadEvent } from '../../shared/event-store.js'
import { toEnvelope, type AnyEnvelope } from '../../shared/events/envelope.js'
import { config } from '../../shared/config.js'
import { redactForShipper, summarize } from '../services/summaries.js'

export const carsRouter = Router()
carsRouter.use(requireAuth)

/**
 * What the original plan promised for delivery: its arrival at the destination yard plus that yard's median
 * local (or foreign-road) time, so it compares like for like with an ETA to placement.
 */
const ORIGINAL_DELIVERY = `((v.legs -> -1 ->> 'plannedArrival')::timestamptz + make_interval(mins => COALESCE((
  SELECT d.p50_minutes FROM dwell_stats d WHERE d.yard_id = tp.destination_yard
     AND d.block = CASE WHEN tp.handoff_road IS NULL THEN 'LOCAL' ELSE 'FOREIGN' END), 0)))`

carsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = req.user!
    const scope = shipperScope(user) ?? ((req.query.shipper as string) || null)
    const status = (req.query.status as string) || null
    const planStatus = (req.query.planStatus as string) || null
    const q = (req.query.q as string)?.trim().toUpperCase() || null
    const { rows } = await pool.query(
      `SELECT cs.car_id, cs.trip_id, cs.shipper_id, s.name AS shipper_name, cs.plan_version, cs.status, cs.location_id, cs.train_run_id,
              cs.position_confidence, cs.last_observed_at, cs.last_event_at, cs.plan_status, cs.missed_reads, cs.late_events, cs.foreign_road,
              tp.origin_yard, tp.destination_yard, tp.destination_customer, tp.handoff_road,
              ce.p10, ce.p50, ce.p90, ce.confidence, ce.final, ce.basis,
              (tp.legs -> -1 ->> 'plannedArrival') AS planned_arrival,
              (SELECT ${ORIGINAL_DELIVERY} FROM trip_plan_versions v WHERE v.trip_id = cs.trip_id AND v.version = 1) AS original_arrival,
              (SELECT COUNT(*)::int FROM exceptions x WHERE x.car_id = cs.car_id AND x.status = 'open') AS open_exceptions
         FROM car_state cs
         LEFT JOIN trip_plans tp ON tp.trip_id = cs.trip_id
         LEFT JOIN car_eta ce ON ce.car_id = cs.car_id
         LEFT JOIN shippers s ON s.shipper_id = cs.shipper_id
        WHERE ($1::text IS NULL OR cs.shipper_id = $1)
          AND ($2::text IS NULL OR cs.status = $2)
          AND ($3::text IS NULL OR cs.plan_status = $3)
          AND ($4::text IS NULL OR cs.car_id LIKE '%' || $4 || '%')
        ORDER BY (cs.status = 'delivered'), ce.p50 NULLS LAST, cs.car_id
        LIMIT 500`,
      [scope, status, planStatus, q],
    )
    const { rows: counts } = await pool.query<{ status: string; n: number }>(
      'SELECT status, COUNT(*)::int AS n FROM car_state WHERE ($1::text IS NULL OR shipper_id = $1) GROUP BY status',
      [scope],
    )
    const { rows: planCounts } = await pool.query<{ plan_status: string; n: number }>(
      'SELECT plan_status, COUNT(*)::int AS n FROM car_state WHERE ($1::text IS NULL OR shipper_id = $1) GROUP BY plan_status',
      [scope],
    )
    const { rows: shippers } = user.role === 'shipper' ? { rows: [] } : await pool.query('SELECT shipper_id, name FROM shippers ORDER BY shipper_id')
    res.json({ cars: rows, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), planCounts: Object.fromEntries(planCounts.map((c) => [c.plan_status, c.n])), shippers })
  }),
)

async function visibleCar(user: SessionUser, carId: string) {
  const { rows } = await pool.query(
    `SELECT cs.*, s.name AS shipper_name, c.car_type, c.owner_mark FROM car_state cs
       LEFT JOIN shippers s ON s.shipper_id = cs.shipper_id LEFT JOIN cars c ON c.car_id = cs.car_id WHERE cs.car_id = $1`,
    [carId],
  )
  const car = rows[0]
  if (!car || !canSeeShipper(user, car.shipper_id)) throw notFound('Car')
  return car
}

carsRouter.get(
  '/:carId',
  asyncHandler(async (req, res) => {
    const car = await visibleCar(req.user!, req.params.carId)
    const tripId = car.trip_id as string | null
    const [plan, versions, eta, history, exceptions, sagas, original] = await Promise.all([
      tripId ? pool.query('SELECT * FROM trip_plans WHERE trip_id = $1', [tripId]) : null,
      tripId ? pool.query('SELECT * FROM trip_plan_versions WHERE trip_id = $1 ORDER BY version', [tripId]) : null,
      pool.query('SELECT * FROM car_eta WHERE car_id = $1', [car.car_id]),
      pool.query('SELECT p10, p50, p90, as_of, plan_version, trigger_type, created_at FROM eta_history WHERE car_id = $1 ORDER BY as_of, id', [car.car_id]),
      pool.query('SELECT * FROM exceptions WHERE car_id = $1 ORDER BY opened_at DESC', [car.car_id]),
      req.user!.role === 'shipper' ? null : pool.query('SELECT * FROM replan_sagas WHERE car_id = $1 ORDER BY created_at', [car.car_id]),
      tripId
        ? pool.query<{ at: Date }>(`SELECT ${ORIGINAL_DELIVERY} AS at FROM trip_plan_versions v JOIN trip_plans tp USING (trip_id) WHERE v.trip_id = $1 AND v.version = 1`, [tripId])
        : null,
    ])
    res.json({
      car,
      plan: plan?.rows[0] ?? null,
      versions: versions?.rows ?? [],
      eta: eta.rows[0] ?? null,
      etaHistory: history.rows,
      exceptions: exceptions.rows,
      sagas: sagas?.rows ?? [],
      originalDelivery: original?.rows[0]?.at ?? null,
    })
  }),
)

function view(e: AnyEnvelope, user: SessionUser, carId: string, outOfOrder: boolean) {
  const lagMinutes = Math.round((Date.parse(e.recordedAt) - Date.parse(e.occurredAt)) / 60_000)
  return {
    position: e.position,
    eventId: e.eventId,
    type: e.type,
    version: e.version,
    upcastFrom: e.upcastFrom ?? null,
    streamId: e.streamId,
    streamVersion: e.streamVersion,
    producer: e.producer,
    occurredAt: e.occurredAt,
    recordedAt: e.recordedAt,
    lagMinutes,
    late: !e.producer.startsWith('svc:') && lagMinutes > config.lateAfterMinutes,
    outOfOrder,
    correlationId: e.correlationId,
    causationId: e.causationId,
    summary: summarize(e, carId),
    payload: user.role === 'shipper' ? redactForShipper(e, carId) : e.payload,
  }
}

carsRouter.get(
  '/:carId/timeline',
  asyncHandler(async (req, res) => {
    const user = req.user!
    const car = await visibleCar(user, req.params.carId)
    const events = await loadCarTimeline(pool, car.car_id)
    // Out of order: a fact recorded after a fact about this car that happened later.
    const outOfOrder = new Set<string>()
    let newest = ''
    for (const e of events) {
      if (e.producer.startsWith('svc:') || e.topic !== 'car') continue
      if (newest && e.occurredAt < newest) outOfOrder.add(e.eventId)
      if (e.occurredAt > newest) newest = e.occurredAt
    }
    res.json({ carId: car.car_id, events: events.map((e) => view(e, user, car.car_id, outOfOrder.has(e.eventId))) })
  }),
)

export const eventsRouter = Router()
eventsRouter.use(requireAuth)

/** The causation chain around one event: its ancestors (causation_id upward) and descendants. */
eventsRouter.get(
  '/:eventId/chain',
  asyncHandler(async (req, res) => {
    const user = req.user!
    const root = await loadEvent(pool, req.params.eventId)
    if (!root) throw notFound('Event')
    const carId = (req.query.car as string) || null
    const ancestors: AnyEnvelope[] = []
    let cursor = root.causation_id
    for (let i = 0; cursor && i < 20; i++) {
      const parent = await loadEvent(pool, cursor)
      if (!parent) break
      ancestors.unshift(toEnvelope(parent))
      cursor = parent.causation_id
    }
    const { rows: desc } = await pool.query(
      `WITH RECURSIVE d AS (
         SELECT e.*, 1 AS depth FROM events e WHERE e.causation_id = $1
         UNION ALL
         SELECT e.*, d.depth + 1 FROM events e JOIN d ON e.causation_id = d.event_id WHERE d.depth < 6
       ) SELECT * FROM d ORDER BY position LIMIT 300`,
      [root.event_id],
    )
    const all = [...ancestors, toEnvelope(root), ...desc.map(toEnvelope)]
    // Shippers see only chain links about their own cars (plus train movements, redacted).
    let allowed = all
    if (user.role === 'shipper') {
      const { rows } = await pool.query<{ position: number }>(
        `SELECT ec.position FROM event_cars ec JOIN trip_plans tp ON tp.car_id = ec.car_id WHERE ec.position = ANY($1) AND tp.shipper_id = $2`,
        [all.map((e) => e.position), user.shipperId],
      )
      const mine = new Set(rows.map((r) => r.position))
      allowed = all.filter((e) => mine.has(e.position) || e.topic === 'train')
      if (!allowed.some((e) => e.eventId === root.event_id)) throw notFound('Event')
    }
    const focus = carId ?? ''
    res.json({
      rootId: root.event_id,
      ancestors: allowed.filter((e) => ancestors.includes(e)).map((e) => view(e, user, focus, false)),
      root: view(toEnvelope(root), user, focus, false),
      descendants: allowed.filter((e) => e.eventId !== root.event_id && !ancestors.includes(e)).map((e) => ({ ...view(e, user, focus, false) })),
    })
  }),
)
