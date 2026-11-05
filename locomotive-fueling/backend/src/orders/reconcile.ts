/**
 * Ticket reconciliation. A fuel ticket (from a pad or a DTL vendor) says how
 * many gallons went into each unit; the processor independently detected the
 * level rise from telemetry. Matching the two catches short fills and sensor
 * drift. For units whose sensor is flagged faulty (running on dead
 * reckoning), the ticket is the only ground truth, so a correction is sent
 * down that locomotive's partition stream, where the processor applies it in
 * order with the readings.
 * @module orders/reconcile
 */
import { raiseAlert } from '../shared/alerts.js'
import { keys, redis } from '../shared/cache.js'
import { config } from '../shared/config.js'
import { pool } from '../shared/db.js'
import { publishEvent } from '../shared/events.js'
import { logger } from '../shared/logger.js'
import { partitionFor } from '../shared/partition.js'
import { simNow } from '../shared/sim-clock.js'
import { withinTolerance } from './tolerance.js'

interface TicketRow {
  id: string
  orderId: string | null
  trainId: string
  locationId: string
  deliveredAt: Date
  gallonsTotal: number
  perUnit: { locomotiveId: string; gallons: number }[]
}

export async function reconcileTickets(): Promise<number> {
  const { rows } = await pool.query<TicketRow>(
    `SELECT id, order_id AS "orderId", train_id AS "trainId", location_id AS "locationId", delivered_at AS "deliveredAt",
            gallons_total AS "gallonsTotal", per_unit AS "perUnit"
       FROM fuel_tickets WHERE status = 'unmatched' ORDER BY delivered_at LIMIT 20`,
  )
  const now = await simNow()
  let done = 0
  for (const t of rows) {
    const units = t.perUnit.map((u) => u.locomotiveId)
    const { rows: events } = await pool.query<{ id: string; locomotiveId: string; observed: number; levelAfter: number }>(
      `SELECT DISTINCT ON (locomotive_id) id, locomotive_id AS "locomotiveId", gallons_observed AS observed, level_after AS "levelAfter"
         FROM fueling_events
        WHERE locomotive_id = ANY($1) AND ticket_id IS NULL AND train_id = $2
          AND started_at BETWEEN $3::timestamptz - interval '4 hours' AND $3::timestamptz + interval '2 hours'
        ORDER BY locomotive_id, started_at DESC`,
      [units, t.trainId, t.deliveredAt],
    )
    const ageHours = (now.getTime() - new Date(t.deliveredAt).getTime()) / 3_600_000
    // Small top-ups don't register as a fueling event (below the detector's jump threshold); only
    // units that took a meaningful amount need telemetry evidence before we compare totals.
    const needEvidence = t.perUnit.filter((u) => u.gallons >= 200).map((u) => u.locomotiveId)
    if (!needEvidence.every((id) => events.some((e) => e.locomotiveId === id))) {
      // Telemetry hasn't shown the fueling yet (the train may still be dwelling). Give it time.
      if (ageHours > 8) {
        await pool.query(`UPDATE fuel_tickets SET status = 'unverified' WHERE id = $1`, [t.id])
        done++
      }
      continue
    }
    const observed = events.reduce((s, e) => s + e.observed, 0)
    const ok = withinTolerance(t.gallonsTotal, observed)
    const status = ok ? 'matched' : 'discrepancy'
    await pool.query(`UPDATE fuel_tickets SET status = $2, telemetry_gallons = $3, discrepancy_gal = $4 WHERE id = $1`, [t.id, status, observed, t.gallonsTotal - observed])
    await pool.query(`UPDATE fueling_events SET ticket_id = $1 WHERE id = ANY($2)`, [t.id, events.map((e) => e.id)])
    if (t.orderId) {
      await pool.query(`UPDATE dtl_orders SET status = $2, updated_at = now() WHERE id = $1 AND status = 'delivered'`, [t.orderId, ok ? 'reconciled' : 'discrepancy'])
      await pool.query(`INSERT INTO dtl_order_events (order_id, from_status, to_status, note) VALUES ($1, 'delivered', $2, $3)`, [
        t.orderId,
        ok ? 'reconciled' : 'discrepancy',
        `Ticket ${Math.round(t.gallonsTotal)} gal vs telemetry ${Math.round(observed)} gal`,
      ])
    }
    if (!ok) {
      await raiseAlert(
        {
          type: 'ticket_discrepancy',
          severity: 'warning',
          trainId: t.trainId,
          locomotiveId: null,
          dedupKey: `ticket_discrepancy:${t.id}`,
          message: `Ticket ${t.id} bills ${Math.round(t.gallonsTotal)} gal at ${t.locationId}, telemetry saw ${Math.round(observed)} gal (${Math.round(t.gallonsTotal - observed)} gal short). Dispute with vendor.`,
        },
        now,
      )
    }
    // Dead-reckoning units: the ticket replaces the sensor as ground truth.
    for (const e of events) {
      const ticketGal = t.perUnit.find((u) => u.locomotiveId === e.locomotiveId)?.gallons ?? 0
      const filter = await redis.get(keys.locoFilter(e.locomotiveId))
      if (filter && JSON.parse(filter).sensorSuspect) {
        const delta = ticketGal - e.observed
        await redis.xadd(keys.telemetryStream(partitionFor(e.locomotiveId, config.telemetry.partitions)), '*', 'c', JSON.stringify({ locomotiveId: e.locomotiveId, delta, ticketId: t.id }))
      }
    }
    await publishEvent({ type: 'ticket', trainId: t.trainId, id: t.id })
    logger.info({ ticket: t.id, status, observed: Math.round(observed), billed: Math.round(t.gallonsTotal) }, 'ticket reconciled')
    done++
  }
  return done
}
