/**
 * Alerts. One open alert per dedup key (type + subject), so a redelivered
 * reading or a repeated check never opens a second copy.
 * @module shared/alerts
 */
import { pool, type Queryable } from './db.js'
import { alertsRaised } from './metrics.js'
import { publishEvent } from './events.js'

export type AlertType =
  | 'low_fuel'
  | 'range_risk'
  | 'leak_suspected'
  | 'sensor_fault'
  | 'order_rejected'
  | 'order_failed'
  | 'order_unknown'
  | 'plan_infeasible'
  | 'missed_stop'
  | 'ticket_discrepancy'
  | 'plan_voided'
  | 'plan_proposal'
  | 'slot_conflict'

export interface AlertIntent {
  type: AlertType
  severity: 'info' | 'warning' | 'critical'
  trainId: string | null
  locomotiveId: string | null
  message: string
  details?: Record<string, unknown>
  /** Defaults to type:locomotive or type:train. */
  dedupKey?: string
}

export function dedupKeyFor(a: Pick<AlertIntent, 'type' | 'trainId' | 'locomotiveId' | 'dedupKey'>): string {
  return a.dedupKey ?? `${a.type}:${a.locomotiveId ?? a.trainId ?? 'fleet'}`
}

/** Opens the alert unless one with the same key is already open. Returns true when a new alert was opened. */
export async function raiseAlert(a: AlertIntent, raisedAt: Date, db: Queryable = pool): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO alerts (type, severity, train_id, locomotive_id, message, dedup_key, raised_at, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (dedup_key) WHERE status <> 'resolved' DO NOTHING
     RETURNING id`,
    [a.type, a.severity, a.trainId, a.locomotiveId, a.message, dedupKeyFor(a), raisedAt, a.details ? JSON.stringify(a.details) : null],
  )
  if (res.rowCount) {
    alertsRaised.inc({ type: a.type })
    await publishEvent({ type: 'alert', trainId: a.trainId, id: res.rows[0].id })
    return true
  }
  return false
}

export async function resolveAlert(dedupKey: string, at: Date, db: Queryable = pool): Promise<void> {
  const res = await db.query(`UPDATE alerts SET status = 'resolved', resolved_at = $2 WHERE dedup_key = $1 AND status <> 'resolved' RETURNING train_id`, [
    dedupKey,
    at,
  ])
  if (res.rowCount) await publishEvent({ type: 'alert', trainId: res.rows[0].train_id })
}
