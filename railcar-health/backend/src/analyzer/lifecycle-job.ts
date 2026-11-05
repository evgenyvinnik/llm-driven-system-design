/**
 * Alert lifecycle sweeper, run by the analyzer every few seconds:
 *
 *  1. Delivery. Pending notification rows are handed to the (simulated)
 *     provider; when it accepts, the row and the alert get delivered_at.
 *     Delivered is not acknowledged: nobody has necessarily read it.
 *  2. Acknowledgment deadlines. An open alert past its ack_due_at escalates to
 *     the next role in its chain (desk -> chief dispatcher -> network operations
 *     center; yard inspectors -> general foreman -> NOC), with a fresh deadline.
 *  3. Approaching the yard. A delivered but unacknowledged alert whose train is
 *     within the approach window of the yard that must catch the car warns that
 *     yard's supervisor now, rather than after the train has gone through.
 *
 * Each step is a guarded UPDATE plus an audit row keyed for idempotency, so two
 * analyzers sweeping at once, or a sweep after a crash, cannot double-escalate.
 * @module analyzer/lifecycle-job
 */
import { config } from '../shared/config.js'
import { pool, withTransaction } from '../shared/db.js'
import { nowMs } from '../shared/clock.js'
import { ACK_DEADLINE_MINUTES, TIER_NAMES } from '../shared/domain.js'
import { publishEvents, type LiveEvent } from '../shared/events.js'
import { logger } from '../shared/logger.js'
import { ackEscalations } from '../shared/metrics.js'
import { decideEscalation, escalationLabel, type OwnerRole } from './ownership.js'

export async function deliverNotifications(): Promise<number> {
  const at = new Date(nowMs())
  const { rows } = await pool.query<{ id: number; alert_id: string; channel: string }>(
    `UPDATE notifications SET delivered_at = $1
      WHERE id IN (SELECT id FROM notifications WHERE delivered_at IS NULL ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED)
      RETURNING id, alert_id, channel`,
    [at],
  )
  const owned = rows.filter((r) => r.channel === 'dispatcher' || r.channel === 'yard')
  for (const alertId of new Set(owned.map((r) => r.alert_id))) {
    const res = await pool.query<{ tier: number }>(`UPDATE alerts SET delivered_at = $2 WHERE id = $1 AND delivered_at IS NULL RETURNING tier`, [alertId, at])
    if (res.rows[0]) {
      await pool.query(
        `INSERT INTO alert_events (alert_id, kind, tier, note, actor, at) VALUES ($1, 'delivered', $2, 'Notification provider accepted the message (not yet acknowledged by a person)', 'notifier', $3) ON CONFLICT DO NOTHING`,
        [alertId, res.rows[0].tier, at],
      )
    }
  }
  return rows.length
}

interface DueRow {
  id: string
  tier: number
  status: string
  owner_role: OwnerRole
  owner_id: string | null
  escalation_level: number
  ack_due_at: Date | null
  yard_id: string | null
  car_id: string
  trip_id: string
  symbol: string
  next_yard_id: string | null
  next_yard_eta: Date | null
  warned_yard: boolean
}

export async function sweepAcknowledgments(): Promise<number> {
  const now = nowMs()
  const { rows } = await pool.query<DueRow>(
    `SELECT a.id, a.tier, a.status, a.owner_role, a.owner_id, a.escalation_level, a.ack_due_at, a.yard_id, a.car_id, a.trip_id, t.symbol,
            t.next_yard_id, t.next_yard_eta,
            EXISTS (SELECT 1 FROM alert_events e WHERE e.alert_id = a.id AND e.kind = 'approaching_yard') AS warned_yard
       FROM alerts a JOIN trips t ON t.trip_id = a.trip_id
      WHERE a.status = 'open' AND a.owner_role IN ('dispatcher', 'yard') AND a.delivered_at IS NOT NULL`,
  )
  const events: LiveEvent[] = []
  for (const r of rows) {
    const headingToAlertYard = r.yard_id !== null && r.next_yard_id === r.yard_id && r.next_yard_eta !== null
    const decision = decideEscalation({
      status: r.status,
      role: r.owner_role,
      level: r.escalation_level,
      ackDueAtMs: r.ack_due_at?.getTime() ?? null,
      nowMs: now,
      yardEtaMs: headingToAlertYard ? r.next_yard_eta!.getTime() : null,
      approachWindowMinutes: config.analysis.approachWindowMinutes,
      alreadyWarnedYard: r.warned_yard,
    })
    if (!decision.escalate) continue
    const at = new Date(now)
    const minutes = ACK_DEADLINE_MINUTES[r.tier] ?? 60
    const label = escalationLabel(r.owner_role, decision.toLevel)
    const target = decision.reason === 'approaching_yard' ? `yard-supervisor:${r.yard_id}` : decision.toLevel >= 2 ? 'operations-center' : `${r.owner_role === 'dispatcher' ? 'chief-dispatcher' : 'yard-supervisor'}:${r.owner_id}`
    const note =
      decision.reason === 'ack_overdue'
        ? `No acknowledgment from ${escalationLabel(r.owner_role, r.escalation_level)} ${r.owner_id ?? ''} within ${minutes} min: escalated to ${label}`
        : `Delivered but unacknowledged and ${r.symbol} is due at ${r.yard_id} within ${config.analysis.approachWindowMinutes} min: ${r.yard_id} supervisor warned so the car is caught`
    const done = await withTransaction(async (client) => {
      // Guarded by the level and status we read, so a concurrent acknowledgment or sweep wins cleanly.
      const res = await client.query(
        `UPDATE alerts SET escalation_level = $3, ack_due_at = $4, updated_at = $5, version = version + 1
          WHERE id = $1 AND status = 'open' AND escalation_level = $2`,
        [r.id, r.escalation_level, decision.toLevel, new Date(now + minutes * 60_000), at],
      )
      if (res.rowCount === 0) return false
      await client.query(
        `INSERT INTO alert_events (alert_id, kind, tier, note, actor, at) VALUES ($1, $2, $3, $4, 'sweeper', $5) ON CONFLICT DO NOTHING`,
        [r.id, decision.reason, decision.toLevel, note, at],
      )
      await client.query(
        `INSERT INTO notifications (alert_id, channel, target, kind, message, dedupe_key, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (dedupe_key) DO NOTHING`,
        [r.id, decision.toLevel >= 2 ? 'operations' : 'supervisor', target, decision.reason, `${TIER_NAMES[r.tier]} ${r.car_id} on ${r.symbol}: ${note}`,
          `${r.id}:${decision.reason}:${decision.toLevel}:${r.yard_id ?? ''}`, at],
      )
      return true
    })
    if (!done) continue
    ackEscalations.inc({ reason: decision.reason })
    logger.info({ alertId: r.id, reason: decision.reason, toLevel: decision.toLevel, target }, 'alert escalated for acknowledgment')
    events.push({ type: 'alert.updated', alertId: r.id, tripId: r.trip_id, yardId: r.yard_id })
  }
  await publishEvents(events)
  return events.length
}

export function startLifecycleJob(): () => void {
  const timer = setInterval(() => {
    deliverNotifications()
      .then(() => sweepAcknowledgments())
      .catch((err) => logger.warn({ err: (err as Error).message }, 'lifecycle sweep failed'))
  }, config.analysis.sweepIntervalMs)
  return () => clearInterval(timer)
}
