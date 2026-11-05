/**
 * Order worker: claims due orders with a lease (FOR UPDATE SKIP LOCKED, so
 * several workers can run), advances each through the state machine outside
 * any transaction, then writes the result fenced on the status it read. If the
 * planner changed the order meanwhile (e.g. asked to cancel it), the fenced
 * write loses and the next pass handles the new status.
 * @module orders/order-worker
 */
import { raiseAlert } from '../shared/alerts.js'
import { config } from '../shared/config.js'
import { pool } from '../shared/db.js'
import { publishEvent } from '../shared/events.js'
import { logger } from '../shared/logger.js'
import { orderTransitions } from '../shared/metrics.js'
import { simNow } from '../shared/sim-clock.js'
import { enqueuePlan } from '../shared/triggers.js'
import { advance, type OrderForVendor, type VendorClient } from './state-machine.js'

export async function claimDueOrders(limit = 10): Promise<OrderForVendor[]> {
  const { rows } = await pool.query(
    `UPDATE dtl_orders o SET lease_until = now() + make_interval(secs => $2), attempts = o.attempts + 1
       FROM fuel_options f
      WHERE o.option_id = f.id AND o.id IN (
        SELECT id FROM dtl_orders
         WHERE status IN ('pending', 'unknown', 'cancel_requested') AND next_attempt_at <= now()
           AND (lease_until IS NULL OR lease_until < now())
         ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING o.id, o.stop_key AS "stopKey", o.status, o.attempts, o.vendor_order_id AS "vendorOrderId", o.train_id AS "trainId",
                o.location_id AS "locationId", o.option_id AS "optionId", o.gallons_requested AS "gallonsRequested", o.per_unit AS "perUnit",
                extract(epoch from o.eta) * 1000 AS "etaMs", f.price_per_gal::float AS "pricePerGal", f.lead_time_hours AS "leadTimeHours"`,
    [limit, config.orders.leaseSeconds],
  )
  return rows.map((r) => ({ ...r, etaMs: Number(r.etaMs) })) as OrderForVendor[]
}

export async function processOrder(order: OrderForVendor, vendor: VendorClient): Promise<void> {
  const now = await simNow()
  const t = await advance(order, vendor, { nowSimMs: now.getTime(), maxAttempts: config.orders.maxAttempts })
  const res = await pool.query(
    `UPDATE dtl_orders SET status = $3, vendor_order_id = COALESCE($4, vendor_order_id), last_error = $5,
            next_attempt_at = now() + make_interval(secs => $6), lease_until = NULL, cancel_fee = COALESCE($7, cancel_fee), updated_at = now()
      WHERE id = $1 AND status = $2`,
    [order.id, order.status, t.to, t.vendorOrderId ?? null, t.error ?? null, (t.retryInMs ?? 0) / 1000, t.cancelFee ?? null],
  )
  if (!res.rowCount) {
    // The planner moved this order on while we were talking to the vendor. Release the lease and let the next pass decide.
    await pool.query('UPDATE dtl_orders SET lease_until = NULL, vendor_order_id = COALESCE(vendor_order_id, $2) WHERE id = $1', [order.id, t.vendorOrderId ?? null])
    logger.info({ order: order.stopKey, wanted: t.to }, 'order changed underneath the worker; result discarded')
    return
  }
  if (t.to !== order.status || t.error) {
    await pool.query('INSERT INTO dtl_order_events (order_id, from_status, to_status, note) VALUES ($1, $2, $3, $4)', [order.id, order.status, t.to, t.note])
  }
  orderTransitions.inc({ to: t.to })
  if (t.alert) await raiseAlert({ type: t.alert.type, severity: t.to === 'failed' ? 'critical' : 'warning', trainId: order.trainId, locomotiveId: null, dedupKey: `${t.alert.type}:${order.stopKey}`, message: t.alert.message }, now)
  if (t.replan) await enqueuePlan(order.trainId, t.replan, `${order.optionId} ${t.to}`)
  await publishEvent({ type: 'order', trainId: order.trainId, id: order.id })
}

export function startOrderWorker(vendor: VendorClient): () => void {
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  const tick = async () => {
    try {
      const due = await claimDueOrders()
      await Promise.all(due.map((o) => processOrder(o, vendor).catch((err) => logger.error({ err, order: o.stopKey }, 'order step failed'))))
    } catch (err) {
      logger.error({ err }, 'order worker tick failed')
    }
    if (!stopped) timer = setTimeout(() => void tick(), config.orders.pollMs)
  }
  void tick()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
