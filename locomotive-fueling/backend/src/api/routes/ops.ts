/**
 * Fuel desk operations: DTL orders and their history, fuel tickets and
 * reconciliation, alerts.
 * @module api/routes/ops
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRole } from '../../shared/auth.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError, notFound } from '../../shared/errors.js'
import { publishEvent } from '../../shared/events.js'
import { simNow } from '../../shared/sim-clock.js'

export const opsRouter = Router()
opsRouter.use(requireAuth)

opsRouter.get(
  '/orders',
  requireRole('fuel_desk'),
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT o.id, o.stop_key AS "stopKey", o.train_id AS "trainId", t.symbol, o.location_id AS "locationId", l.name AS "locationName",
              o.option_id AS "optionId", f.vendor, o.plan_version AS "planVersion", o.gallons_requested AS "gallonsRequested",
              o.gallons_delivered AS "gallonsDelivered", extract(epoch from o.eta) * 1000 AS "etaMs", o.status, o.vendor_order_id AS "vendorOrderId",
              o.attempts, o.last_error AS "lastError", o.cancel_fee::float AS "cancelFee", o.created_at AS "createdAt", o.updated_at AS "updatedAt",
              COALESCE((SELECT json_agg(json_build_object('at', e.at, 'from', e.from_status, 'to', e.to_status, 'note', e.note) ORDER BY e.id)
                          FROM dtl_order_events e WHERE e.order_id = o.id), '[]') AS events
         FROM dtl_orders o JOIN trains t ON t.id = o.train_id JOIN locations l ON l.id = o.location_id JOIN fuel_options f ON f.id = o.option_id
        ORDER BY (o.status IN ('pending', 'unknown', 'cancel_requested', 'failed', 'discrepancy')) DESC, o.updated_at DESC LIMIT 200`,
    )
    res.json({ orders: rows.map((r) => ({ ...r, etaMs: Number(r.etaMs) })) })
  }),
)

opsRouter.post(
  '/orders/:id/cancel',
  requireRole('fuel_desk'),
  asyncHandler(async (req, res) => {
    const r = await pool.query<{ train_id: string }>(
      `UPDATE dtl_orders SET status = 'cancel_requested', next_attempt_at = now(), updated_at = now()
        WHERE id = $1 AND status IN ('pending', 'unknown', 'confirmed') RETURNING train_id`,
      [req.params.id],
    )
    if (!r.rowCount) throw new HttpError(409, 'NOT_CANCELLABLE', 'Order is not in a cancellable state')
    await pool.query(`INSERT INTO dtl_order_events (order_id, from_status, to_status, note) VALUES ($1, NULL, 'cancel_requested', $2)`, [
      req.params.id,
      `Cancelled by ${req.user!.username}`,
    ])
    await publishEvent({ type: 'order', trainId: r.rows[0].train_id, id: req.params.id })
    res.status(202).json({ status: 'cancel_requested' })
  }),
)

opsRouter.get(
  '/tickets',
  requireRole('fuel_desk'),
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT k.id, k.source, k.train_id AS "trainId", t.symbol, k.location_id AS "locationId", l.name AS "locationName", k.gallons_total AS "gallonsTotal",
              k.telemetry_gallons AS "telemetryGallons", k.discrepancy_gal AS "discrepancyGal", k.price_per_gal::float AS "pricePerGal", k.fee::float AS fee,
              k.status, k.delivered_at AS "deliveredAt"
         FROM fuel_tickets k JOIN trains t ON t.id = k.train_id JOIN locations l ON l.id = k.location_id
        ORDER BY k.delivered_at DESC LIMIT 100`,
    )
    const totals = await pool.query<{ gallons: number; cost: number }>(
      `SELECT COALESCE(sum(gallons_total), 0)::float AS gallons, COALESCE(sum(gallons_total * price_per_gal + fee), 0)::float AS cost FROM fuel_tickets`,
    )
    res.json({ tickets: rows, totals: totals.rows[0] })
  }),
)

opsRouter.get(
  '/alerts',
  asyncHandler(async (req, res) => {
    const user = req.user!
    const status = z.enum(['open', 'all']).default('open').parse(req.query.status)
    const args: unknown[] = []
    const where: string[] = []
    if (status === 'open') where.push(`a.status <> 'resolved'`)
    if (user.role === 'crew') {
      args.push(user.trainId)
      where.push(`a.train_id = $${args.length}`)
    }
    const { rows } = await pool.query(
      `SELECT a.id, a.type, a.severity, a.train_id AS "trainId", t.symbol, a.locomotive_id AS "locomotiveId", a.message, a.status,
              a.raised_at AS "raisedAt", a.acknowledged_by AS "acknowledgedBy", a.details
         FROM alerts a LEFT JOIN trains t ON t.id = a.train_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY (a.status = 'open') DESC, (a.severity = 'critical') DESC, a.id DESC LIMIT 200`,
      args,
    )
    res.json({ alerts: rows })
  }),
)

opsRouter.post(
  '/alerts/:id/ack',
  requireRole('fuel_desk'),
  asyncHandler(async (req, res) => {
    const r = await pool.query<{ train_id: string | null }>(
      `UPDATE alerts SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = $3 WHERE id = $1 AND status = 'open' RETURNING train_id`,
      [req.params.id, req.user!.username, await simNow()],
    )
    if (!r.rowCount) throw notFound('Open alert')
    await publishEvent({ type: 'alert', trainId: r.rows[0].train_id, id: req.params.id })
    res.json({ status: 'acknowledged' })
  }),
)
