/**
 * Machine-to-machine endpoints. Onboard units post telemetry with a device
 * token; the dispatch system (reroutes, new trips, arrivals), pad fuel system
 * and DTL vendor (tickets), and the price feed use an integration token.
 * Locally the simulator plays the onboard units, dispatch and the pads.
 * @module api/routes/integrations
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireToken } from '../../shared/auth.js'
import { config } from '../../shared/config.js'
import { pool, withTransaction } from '../../shared/db.js'
import { asyncHandler, HttpError, notFound } from '../../shared/errors.js'
import { publishEvent } from '../../shared/events.js'
import { loadTracks, loadTrain, loadTrains } from '../../shared/repo.js'
import { readClock, simNow, writeClock } from '../../shared/sim-clock.js'
import { readStates } from '../../shared/state.js'
import { enqueuePlan } from '../../shared/triggers.js'
import { ingestBatch } from '../services/ingest.js'
import { changePrice } from '../services/prices.js'

export const telemetryRouter = Router()
telemetryRouter.use(requireToken('X-Device-Token', () => config.deviceToken))

telemetryRouter.post(
  '/batch',
  asyncHandler(async (req, res) => {
    const result = await ingestBatch(req.body)
    // 202: accepted into the log. 200 for a replayed batch, so devices can tell the difference.
    res.status(result.duplicate ? 200 : 202).json(result)
  }),
)

export const integrationsRouter = Router()
integrationsRouter.use(requireToken('X-Integration-Token', () => config.integrationToken))

integrationsRouter.put(
  '/clock',
  asyncHandler(async (req, res) => {
    const body = z.object({ simMs: z.number(), speedup: z.number().positive() }).parse(req.body)
    await writeClock({ simMs: body.simMs, wallMs: Date.now(), speedup: body.speedup })
    res.status(204).end()
  }),
)

/** Everything the simulator needs to (re)start: clock, running trains with consists and last known state. */
integrationsRouter.get(
  '/sim/bootstrap',
  asyncHandler(async (_req, res) => {
    const trains = await loadTrains({ status: 'running' })
    const states = await readStates(trains.flatMap((t) => t.units.map((u) => u.locomotiveId)))
    const { rows: idle } = await pool.query<{ id: string }>(
      `SELECT l.id FROM locomotives l WHERE NOT EXISTS (SELECT 1 FROM consist_units c JOIN trains t ON t.id = c.train_id WHERE c.locomotive_id = l.id AND t.status = 'running')`,
    )
    res.json({
      clock: await readClock(),
      trains: trains.map((t) => ({ ...t, units: t.units.map((u) => ({ ...u, state: states.get(u.locomotiveId) ?? null })) })),
      idleLocomotives: idle.map((r) => r.id),
    })
  }),
)

/** The crew's instructions: the current plan's stops with per-unit fill targets and DTL order state. */
integrationsRouter.get(
  '/trains/:id/instructions',
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT p.version, s.stop_key AS "stopKey", s.location_id AS "locationId", s.option_id AS "optionId", s.kind, s.milepost, s.per_unit AS "perUnit",
              f.setup_minutes AS "setupMinutes", f.pump_gpm AS "pumpGpm", f.price_per_gal::float AS "pricePerGal",
              o.vendor_order_id AS "vendorOrderId", o.status AS "orderStatus"
         FROM fuel_plans p JOIN plan_stops s ON s.plan_id = p.id JOIN fuel_options f ON f.id = s.option_id
         LEFT JOIN dtl_orders o ON o.stop_key = s.stop_key
        WHERE p.train_id = $1 AND p.is_current ORDER BY s.seq`,
      [req.params.id],
    )
    res.json({ trainId: req.params.id, version: rows[0]?.version ?? null, stops: rows })
  }),
)

const newTrainSchema = z.object({
  symbol: z.string().min(1).max(32),
  routeId: z.string(),
  plannedTons: z.number().int().positive(),
  cars: z.number().int().positive(),
  units: z.array(z.string()).min(1).max(6),
  departedAt: z.number(),
})

integrationsRouter.post(
  '/trains',
  asyncHandler(async (req, res) => {
    const body = newTrainSchema.parse(req.body)
    const id = await withTransaction(async (db) => {
      const route = await db.query<{ path: string[] }>('SELECT path FROM routes WHERE id = $1', [body.routeId])
      if (!route.rows[0]) throw notFound('Route')
      const busy = await db.query(
        `SELECT c.locomotive_id FROM consist_units c JOIN trains t ON t.id = c.train_id WHERE t.status = 'running' AND c.locomotive_id = ANY($1)`,
        [body.units],
      )
      if (busy.rowCount) throw new HttpError(409, 'UNITS_BUSY', `Units already in a running train: ${busy.rows.map((r) => r.locomotive_id).join(', ')}`)
      const next = await db.query<{ n: number }>(`SELECT count(*)::int + 1 AS n FROM trains`)
      const trainId = `T${String(next.rows[0].n).padStart(2, '0')}`
      await db.query(
        `INSERT INTO trains (id, symbol, route_id, path, planned_tons, cars, departed_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [trainId, body.symbol, body.routeId, route.rows[0].path, body.plannedTons, body.cars, new Date(body.departedAt)],
      )
      for (const [i, loco] of body.units.entries()) {
        await db.query(`INSERT INTO consist_units (train_id, locomotive_id, position, role) VALUES ($1, $2, $3, $4)`, [
          trainId,
          loco,
          i + 1,
          i === 0 ? 'lead' : i === body.units.length - 1 && body.units.length > 2 ? 'dp' : 'trailing',
        ])
      }
      return trainId
    })
    await enqueuePlan(id, 'initial')
    await publishEvent({ type: 'train', trainId: id })
    res.status(201).json({ id })
  }),
)

integrationsRouter.post(
  '/trains/:id/arrive',
  asyncHandler(async (req, res) => {
    const at = new Date(z.object({ arrivedAt: z.number() }).parse(req.body).arrivedAt)
    const r = await pool.query(`UPDATE trains SET status = 'arrived', arrived_at = $2, updated_at = now() WHERE id = $1 AND status = 'running'`, [req.params.id, at])
    if (r.rowCount) {
      // Any truck still on order for this trip is no longer needed.
      await pool.query(
        `UPDATE dtl_orders SET status = CASE WHEN status = 'pending' AND attempts = 0 THEN 'cancelled' ELSE 'cancel_requested' END, next_attempt_at = now(), updated_at = now()
          WHERE train_id = $1 AND status IN ('pending', 'unknown', 'confirmed')`,
        [req.params.id],
      )
      await pool.query(`UPDATE alerts SET status = 'resolved', resolved_at = $2 WHERE train_id = $1 AND locomotive_id IS NULL AND status <> 'resolved'`, [req.params.id, at])
      await publishEvent({ type: 'train', trainId: req.params.id, note: 'arrived' })
    }
    res.json({ arrived: Boolean(r.rowCount) })
  }),
)

/** Reroute from a location still ahead of the train. The path behind it is kept, so mileposts stay continuous. */
integrationsRouter.post(
  '/trains/:id/reroute',
  asyncHandler(async (req, res) => {
    const body = z.object({ path: z.array(z.string()).min(2), reason: z.string().max(200) }).parse(req.body)
    const train = await loadTrain(req.params.id)
    if (!train || train.status !== 'running') throw notFound('Running train')
    const from = body.path[0]
    const idx = train.path.indexOf(from)
    const lastIdx = train.lastLocation ? train.path.indexOf(train.lastLocation) : 0
    if (idx < 0 || idx < lastIdx) throw new HttpError(409, 'BAD_REROUTE', `${from} is not ahead of the train`)
    const newPath = [...train.path.slice(0, idx), ...body.path]
    const tracks = await loadTracks()
    for (let i = 0; i < newPath.length - 1; i++) {
      const a = newPath[i]
      const b = newPath[i + 1]
      if (!tracks.some((t) => (t.a === a && t.b === b) || (t.a === b && t.b === a))) throw new HttpError(422, 'NO_TRACK', `No track between ${a} and ${b}`)
    }
    await pool.query(`UPDATE trains SET path = $2, path_version = path_version + 1, updated_at = now() WHERE id = $1`, [train.id, newPath])
    await enqueuePlan(train.id, 'reroute', body.reason)
    await publishEvent({ type: 'train', trainId: train.id, note: 'rerouted' })
    res.json({ path: newPath })
  }),
)

const ticketSchema = z.object({
  ticketId: z.string().min(3).max(100),
  source: z.enum(['pad', 'vendor']),
  vendorOrderId: z.string().optional(),
  stopKey: z.string().optional(),
  trainId: z.string(),
  locationId: z.string(),
  optionId: z.string(),
  deliveredAt: z.union([z.string().datetime(), z.number()]).transform((v) => new Date(v)),
  pricePerGal: z.number().positive(),
  perUnit: z.array(z.object({ locomotiveId: z.string(), gallons: z.number().nonnegative() })).min(1),
})

/** Fuel tickets, idempotent on the source's ticket id (webhooks are retried). */
integrationsRouter.post(
  '/fuel-tickets',
  asyncHandler(async (req, res) => {
    const t = ticketSchema.parse(req.body)
    const total = t.perUnit.reduce((s, u) => s + u.gallons, 0)
    const result = await withTransaction(async (db) => {
      const order = t.stopKey
        ? await db.query<{ id: string; fee: number }>(
            `SELECT o.id, f.fee::float AS fee FROM dtl_orders o JOIN fuel_options f ON f.id = o.option_id WHERE o.stop_key = $1`,
            [t.stopKey],
          )
        : { rows: [] as { id: string; fee: number }[] }
      const ins = await db.query(
        `INSERT INTO fuel_tickets (id, source, order_id, stop_key, train_id, location_id, option_id, delivered_at, gallons_total, per_unit, price_per_gal, fee)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (id) DO NOTHING`,
        [t.ticketId, t.source, order.rows[0]?.id ?? null, t.stopKey ?? null, t.trainId, t.locationId, t.optionId, t.deliveredAt, total, JSON.stringify(t.perUnit), t.pricePerGal, order.rows[0]?.fee ?? 0],
      )
      if (ins.rowCount && order.rows[0]) {
        await db.query(`UPDATE dtl_orders SET status = 'delivered', gallons_delivered = $2, updated_at = now() WHERE id = $1 AND status IN ('confirmed', 'cancel_requested', 'unknown')`, [
          order.rows[0].id,
          total,
        ])
        await db.query(`INSERT INTO dtl_order_events (order_id, from_status, to_status, note) VALUES ($1, 'confirmed', 'delivered', $2)`, [
          order.rows[0].id,
          `Ticket ${t.ticketId}: ${Math.round(total)} gal`,
        ])
      }
      return { duplicate: !ins.rowCount, orderId: order.rows[0]?.id ?? null }
    })
    if (!result.duplicate) {
      await enqueuePlan(t.trainId, 'fueled', `${t.source} ticket ${Math.round(total)} gal at ${t.locationId}`)
      await publishEvent({ type: 'ticket', trainId: t.trainId, id: t.ticketId })
      if (result.orderId) await publishEvent({ type: 'order', trainId: t.trainId, id: result.orderId })
    }
    res.status(result.duplicate ? 200 : 201).json(result)
  }),
)

/** Daily price feed from fuel suppliers. */
integrationsRouter.post(
  '/prices',
  asyncHandler(async (req, res) => {
    const body = z.object({ optionId: z.string(), pricePerGal: z.number().positive().max(20), note: z.string().max(200).optional() }).parse(req.body)
    const result = await changePrice(body.optionId, { pricePerGal: body.pricePerGal }, 'price-feed', body.note ?? null, await simNow())
    res.json(result)
  }),
)
