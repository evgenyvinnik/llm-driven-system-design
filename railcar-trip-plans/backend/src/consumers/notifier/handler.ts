/**
 * Consumer group `notifier`: turns car-level changes into one digest per shipper.
 *
 * 1. Each relevant event becomes a notification item (unique on its source event id, so a redelivery adds
 *    nothing) and opens or extends that shipper's batching window.
 * 2. A tick flushes a shipper's window once it has been quiet for DIGEST_QUIET_MS, or has been open for
 *    DIGEST_MAX_WINDOW_MS, and never more often than DIGEST_MIN_INTERVAL_MS per shipper. The flush builds
 *    the digest, records what each car was told, and appends ShipperNotified, in one transaction.
 *
 * A 100-car train six hours late therefore produces 100 EtaUpdated events, about 100 items, and one digest
 * per affected shipper. Batching runs on wall-clock time: it is about not flooding people's inboxes, which
 * happens in real time even when the simulation compresses event time.
 * @module consumers/notifier/handler
 */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { buildDigest, type DigestItem, type ItemKind, type LastNotified } from '../../domain/digest.js'
import { nowMs } from '../../shared/clock.js'
import { config } from '../../shared/config.js'
import { withTransaction, pool } from '../../shared/db.js'
import { append } from '../../shared/event-store.js'
import type { AnyEnvelope } from '../../shared/events/envelope.js'
import type { EventType } from '../../shared/events/schemas.js'
import type { HandlerContext } from '../../shared/consumer.js'
import { digestsSent } from '../../shared/metrics.js'

export const NOTIFIER_TYPES: EventType[] = ['EtaUpdated', 'ReplanCompleted', 'ExceptionOpened', 'CarPlaced']

async function addItem(tx: PoolClient, e: AnyEnvelope, shipperId: string, carId: string, tripId: string | null, kind: ItemKind, payload: Record<string, unknown>) {
  const res = await tx.query(
    `INSERT INTO notification_items (shipper_id, car_id, trip_id, kind, source_event_id, payload, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (source_event_id) DO NOTHING`,
    [shipperId, carId, tripId, kind, e.eventId, JSON.stringify(payload), e.occurredAt],
  )
  if (res.rowCount === 0) return
  await tx.query(
    `INSERT INTO shipper_digest_state (shipper_id, window_opened_at, last_item_at) VALUES ($1, now(), now())
     ON CONFLICT (shipper_id) DO UPDATE SET window_opened_at = COALESCE(shipper_digest_state.window_opened_at, now()), last_item_at = now()`,
    [shipperId],
  )
}

export async function handleNotifier(e: AnyEnvelope, ctx: HandlerContext): Promise<void> {
  const { tx } = ctx
  switch (e.type) {
    case 'EtaUpdated': {
      const p = e.payload
      if (p.final) return
      await addItem(tx, e, p.shipperId, p.carId, p.tripId, 'eta_change', { p10: p.p10, p50: p.p50, p90: p.p90, previousP50: p.previousP50, planVersion: p.planVersion, trigger: p.trigger })
      return
    }
    case 'ReplanCompleted': {
      const p = e.payload
      await addItem(tx, e, p.shipperId, p.carId, p.tripId, 'replanned', { fromPlanVersion: p.fromPlanVersion, toPlanVersion: p.toPlanVersion, reasonText: p.reasonText, etaAfter: p.etaAfter, chosenRunId: p.chosenRunId })
      return
    }
    case 'ExceptionOpened': {
      const p = e.payload
      if (p.type !== 'bad_order' || !p.shipperId) return
      await addItem(tx, e, p.shipperId, p.carId, p.tripId, 'bad_order', { yardId: p.yardId, defect: (p.detail as { defect?: string }).defect ?? null })
      return
    }
    case 'CarPlaced': {
      const { rows } = await tx.query<{ trip_id: string; shipper_id: string }>('SELECT trip_id, shipper_id FROM trip_plans WHERE car_id = $1 ORDER BY released_at DESC LIMIT 1', [e.payload.carId])
      if (!rows[0]) return
      await addItem(tx, e, rows[0].shipper_id, e.payload.carId, rows[0].trip_id, 'delivered', { customerId: e.payload.customerId })
      return
    }
    default:
      return
  }
}

/** Flushes every shipper whose window is due. Returns the digests sent. */
export async function flushDigests(): Promise<number> {
  const { rows } = await pool.query<{ shipper_id: string }>(
    `SELECT shipper_id FROM shipper_digest_state
      WHERE window_opened_at IS NOT NULL
        AND (now() - last_item_at >= make_interval(secs => $1) OR now() - window_opened_at >= make_interval(secs => $2))
        AND (last_sent_at IS NULL OR now() - last_sent_at >= make_interval(secs => $3))`,
    [config.notifier.quietMs / 1000, config.notifier.maxWindowMs / 1000, config.notifier.minIntervalMs / 1000],
  )
  let sent = 0
  for (const { shipper_id } of rows) if (await flushShipper(shipper_id)) sent++
  return sent
}

async function flushShipper(shipperId: string): Promise<boolean> {
  return withTransaction(async (tx) => {
    const { rows: state } = await tx.query('SELECT 1 FROM shipper_digest_state WHERE shipper_id = $1 AND window_opened_at IS NOT NULL FOR UPDATE', [shipperId])
    if (!state[0]) return false
    const { rows: pending } = await tx.query<{ id: number; car_id: string; kind: ItemKind; payload: Record<string, unknown>; occurred_at: Date }>(
      'SELECT id, car_id, kind, payload, occurred_at FROM notification_items WHERE shipper_id = $1 AND digest_id IS NULL ORDER BY id FOR UPDATE',
      [shipperId],
    )
    const items: DigestItem[] = pending.map((r) => ({ carId: r.car_id, kind: r.kind, payload: r.payload, occurredAt: r.occurred_at.toISOString() }))
    const carIds = [...new Set(items.map((i) => i.carId))]
    const { rows: lastRows } = await tx.query<{ car_id: string; p50: Date | null; plan_version: number | null }>(
      'SELECT car_id, p50, plan_version FROM car_last_notified WHERE car_id = ANY($1)',
      [carIds],
    )
    const last = new Map<string, LastNotified>(lastRows.map((r) => [r.car_id, { p50: r.p50?.toISOString() ?? null, planVersion: r.plan_version }]))
    const digest = buildDigest(items, last, config.notifier.etaShiftMinutes)
    const digestId = `DG-${shipperId}-${randomUUID().slice(0, 8).toUpperCase()}`
    const ids = pending.map((r) => r.id)

    if (digest.lines.length === 0) {
      await tx.query("UPDATE notification_items SET digest_id = 'suppressed' WHERE id = ANY($1)", [ids])
      await tx.query('UPDATE shipper_digest_state SET window_opened_at = NULL WHERE shipper_id = $1', [shipperId])
      digestsSent.inc({ kind: 'suppressed_window' })
      return false
    }

    const simTime = new Date(nowMs()).toISOString()
    const event = await append(tx, {
      type: 'ShipperNotified',
      occurredAt: simTime,
      producer: 'svc:notifier',
      dedupeKey: `sn:${digestId}`,
      payload: { shipperId, digestId, carIds: digest.carIds, itemCount: items.length, suppressedCount: digest.suppressed, channel: 'email', subject: digest.subject, lines: digest.lines.map((l) => l.text) },
    })
    await tx.query(
      `INSERT INTO digests (digest_id, shipper_id, sim_time, item_count, car_count, suppressed_count, lines, event_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [digestId, shipperId, simTime, items.length, digest.carIds.length, digest.suppressed, JSON.stringify(digest.lines), event.eventId],
    )
    await tx.query('UPDATE notification_items SET digest_id = $2 WHERE id = ANY($1)', [ids, digestId])
    for (const [carId, told] of digest.told) {
      await tx.query(
        `INSERT INTO car_last_notified (car_id, p50, plan_version, notified_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (car_id) DO UPDATE SET p50 = EXCLUDED.p50, plan_version = EXCLUDED.plan_version, notified_at = now()`,
        [carId, told.p50, told.planVersion],
      )
    }
    await tx.query('UPDATE shipper_digest_state SET window_opened_at = NULL, last_sent_at = now() WHERE shipper_id = $1', [shipperId])
    digestsSent.inc({ kind: 'digest' })
    digestsSent.inc({ kind: 'items_collapsed' }, items.length)
    return true
  })
}
