/**
 * alert-queue projection: alerts, car_holds, work_orders, findings,
 * notifications and bearing_trends_latest, from the cases, cars and trends
 * streams.
 *
 * Rules that make a rebuild from position 0 identical to the live tables:
 *  - only values carried by events are written (occurred_at, payload, stream
 *    version, global position): no now(), no generated ids;
 *  - case events come from one stream (cases) in order, so per-case updates can
 *    assume order;
 *  - the trends stream is not ordered relative to cases, so trend telemetry goes
 *    to its own table as last-writer-wins by global position (commutative).
 * @module workers/projections/alert-queue
 */
import type { Queryable } from '../../shared/db.js'
import type { LiveEvent } from '../../shared/events.js'
import type { EventEnvelope } from '../../events/envelope.js'

type P = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

async function touchAlert(db: Queryable, e: EventEnvelope, set: string, params: unknown[]): Promise<void> {
  await db.query(`UPDATE alerts SET ${set}, version = $2, last_position = $3, updated_at = $4 WHERE id = $1`, [
    (e.payload as P).caseId, e.streamVersion, e.globalPosition, e.occurredAt, ...params,
  ])
}

export async function applyAlertQueue(db: Queryable, e: EventEnvelope): Promise<LiveEvent[]> {
  const p = e.payload as P
  const at = e.occurredAt
  switch (e.type) {
    case 'AlertRaised':
      await db.query(
        `INSERT INTO alerts (id, trip_id, car_id, kind, position, tier, status, owner_role, owner_id, escalation_level, ack_due_at, action, routing, desk_id,
                             territory_id, yard_id, reasons, features, route_note, trigger_detector_id, trigger_pass_id, trigger_passed_at, data_lag_seconds,
                             late, opened_at, updated_at, version, last_position)
         VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8,0,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$23,$24,$25)
         ON CONFLICT (id) DO NOTHING`,
        [p.caseId, p.tripId, p.carId, p.kind, p.position, p.tier, p.owner.role, p.owner.id, p.ackDueAt, p.action, p.routing, p.deskId, p.territoryId, p.yardId,
          JSON.stringify(p.reasons), JSON.stringify(p.features), p.routeNote, p.trigger.detectorId, p.trigger.passId, p.trigger.passedAt, p.trigger.lagSeconds,
          p.late, at, e.streamVersion, e.globalPosition],
      )
      return [{ type: 'alert.opened', alertId: p.caseId, tripId: p.tripId, carId: p.carId, tier: p.tier, deskId: p.deskId, yardId: p.yardId, late: p.late }]
    case 'AlertEscalated':
      await touchAlert(db, e,
        `tier = $5, action = $6, routing = $7, desk_id = $8, territory_id = $9, yard_id = $10, reasons = $11, features = $12, route_note = $13,
         trigger_detector_id = $14, trigger_pass_id = $15, trigger_passed_at = $16, data_lag_seconds = $17, late = $18, escalated_at = $4,
         owner_role = $19, owner_id = $20, ack_due_at = $21, escalation_level = 0, status = CASE WHEN $22 THEN 'open' ELSE status END`,
        [p.toTier, p.action, p.routing, p.deskId, p.territoryId, p.yardId, JSON.stringify(p.reasons), JSON.stringify(p.features), p.routeNote,
          p.trigger.detectorId, p.trigger.passId, p.trigger.passedAt, p.trigger.lagSeconds, p.late, p.owner.role, p.owner.id, p.ackDueAt, p.reopened])
      await db.query('UPDATE work_orders SET priority = GREATEST(priority, $2) WHERE case_id = $1', [p.caseId, p.toTier])
      return [{ type: 'alert.escalated', alertId: p.caseId, tier: p.toTier, deskId: p.deskId, yardId: p.yardId, late: p.late }]
    case 'AlertHandedOff':
      await touchAlert(db, e,
        `owner_role = $5, owner_id = $6, ack_due_at = $7, escalation_level = 0, route_note = $8,
         status = CASE WHEN status = 'acknowledged' THEN 'open' ELSE status END,
         desk_id = CASE WHEN $5 = 'dispatcher' THEN $6 ELSE desk_id END, yard_id = CASE WHEN $5 = 'yard' THEN $6 ELSE yard_id END`,
        [p.to.role, p.to.id, p.ackDueAt, p.note])
      return [{ type: 'alert.updated', alertId: p.caseId, deskId: p.to.role === 'dispatcher' ? p.to.id : null, yardId: p.to.role === 'yard' ? p.to.id : null }]
    case 'CarHoldMoved':
      await db.query('UPDATE car_holds SET yard_id = $2 WHERE id = $1', [p.holdId, p.toYardId])
      if (p.workOrderId) await db.query('UPDATE work_orders SET yard_id = $2, version = version + 1 WHERE id = $1', [p.workOrderId, p.toYardId])
      await touchAlert(db, e, 'yard_id = $5', [p.toYardId])
      return [{ type: 'workorder.updated', alertId: p.caseId, yardId: p.toYardId }, { type: 'workorder.updated', alertId: p.caseId, yardId: p.fromYardId }]
    case 'AlertAcknowledged':
      await touchAlert(db, e, `status = 'acknowledged', acknowledged_by = $5, acknowledged_at = $4, ack_action = $6, ack_note = $7`, [p.by, p.action, p.note])
      return [{ type: 'alert.updated', alertId: p.caseId }]
    case 'AckDeadlineMissed':
      await touchAlert(db, e, 'escalation_level = $5, ack_due_at = $6', [p.toLevel, p.nextAckDueAt])
      return [{ type: 'alert.updated', alertId: p.caseId }]
    case 'ApproachingYardWarned':
      await touchAlert(db, e, 'escalation_level = GREATEST(escalation_level, $5)', [p.toLevel])
      return [{ type: 'alert.updated', alertId: p.caseId, yardId: p.yardId }]
    case 'NotificationRequested':
      await db.query(
        `INSERT INTO notifications (id, alert_id, channel, target, kind, message, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
        [p.notificationId, p.caseId, p.channel, p.target, p.kind, p.message, at],
      )
      return []
    case 'NotificationDelivered':
      await db.query('UPDATE notifications SET delivered_at = $2 WHERE id = $1', [p.notificationId, at])
      if (p.channel === 'dispatcher' || p.channel === 'yard') {
        await touchAlert(db, e, 'delivered_at = COALESCE(delivered_at, $4)', [])
        return [{ type: 'alert.updated', alertId: p.caseId }]
      }
      await db.query('UPDATE alerts SET version = $2, last_position = $3 WHERE id = $1', [p.caseId, e.streamVersion, e.globalPosition])
      return []
    case 'CarHoldPlaced':
      await db.query(
        `INSERT INTO car_holds (id, car_id, alert_id, yard_id, status, reason, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
        [p.holdId, p.carId, p.caseId, p.yardId, p.status, p.reason, at],
      )
      await touchAlert(db, e, 'yard_id = COALESCE(yard_id, $5)', [p.yardId])
      return [{ type: 'workorder.updated', alertId: p.caseId, yardId: p.yardId }]
    case 'CarHoldReleased':
      await db.query(`UPDATE car_holds SET status = 'released', released_at = $2, released_by = $3 WHERE id = $1`, [p.holdId, at, p.by])
      await db.query('UPDATE alerts SET version = $2, last_position = $3 WHERE id = $1', [p.caseId, e.streamVersion, e.globalPosition])
      return [{ type: 'workorder.updated', alertId: p.caseId, yardId: p.yardId }]
    case 'WorkOrderOpened':
      await db.query(
        `INSERT INTO work_orders (id, case_id, alert_id, trip_id, car_id, position, kind, yard_id, priority, status, created_at, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', $10, 1) ON CONFLICT (id) DO NOTHING`,
        [p.workOrderId, p.caseId, p.caseType === 'alert' ? p.caseId : null, p.tripId, p.carId, p.position, p.caseType === 'audit' ? 'audit' : p.kind, p.yardId, p.priority, at],
      )
      if (p.caseType === 'alert') await db.query('UPDATE alerts SET version = $2, last_position = $3 WHERE id = $1', [p.caseId, e.streamVersion, e.globalPosition])
      return [{ type: 'workorder.updated', alertId: p.caseType === 'alert' ? p.caseId : undefined, yardId: p.yardId }]
    case 'WorkOrderStarted':
      await db.query(`UPDATE work_orders SET status = 'in_progress', assigned_to = $2, version = version + 1 WHERE id = $1`, [p.workOrderId, p.by])
      await db.query('UPDATE alerts SET version = $2, last_position = $3 WHERE id = $1', [p.caseId, e.streamVersion, e.globalPosition])
      return [{ type: 'workorder.updated', alertId: p.caseId }]
    case 'InspectionFindingRecorded': {
      await db.query(
        `INSERT INTO findings (id, client_submission_id, case_id, work_order_id, alert_id, car_id, position, source, finding, disposition, notes, recorded_by,
                               observed_at, recorded_at, schema_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) ON CONFLICT (id) DO NOTHING`,
        [p.findingId, p.clientSubmissionId, p.caseId, p.workOrderId, p.source === 'alert' ? p.caseId : null, p.carId, p.position, p.source, p.finding,
          p.disposition, p.notes, p.recordedBy, p.observedAt, e.recordedAt, e.storedVersion],
      )
      if (!p.caseId) return []
      if (p.supersedesFindingId) await db.query('UPDATE findings SET superseded_by = $2 WHERE id = $1', [p.supersedesFindingId, p.findingId])
      if (p.workOrderId) {
        await db.query(
          `UPDATE work_orders SET status = 'completed', completed_at = $2, assigned_to = COALESCE(assigned_to, $3), version = version + 1 WHERE id = $1`,
          [p.workOrderId, at, p.recordedBy],
        )
      }
      if (p.disposition === 'bad_order') await db.query(`UPDATE car_holds SET status = 'bad_ordered', released_at = NULL, released_by = $2 WHERE alert_id = $1 AND status = 'active'`, [p.caseId, p.recordedBy])
      if (p.source === 'alert') await touchAlert(db, e, `status = 'inspected', outcome = $5, inspected_at = $4, closed_at = NULL`, [p.finding])
      return [{ type: 'workorder.updated', alertId: p.source === 'alert' ? p.caseId : undefined }, { type: 'alert.updated', alertId: p.caseId }]
    }
    case 'CaseClosed':
      await db.query(`UPDATE work_orders SET status = 'cancelled', completed_at = $2, version = version + 1 WHERE case_id = $1 AND status IN ('open', 'in_progress')`, [p.caseId, at])
      await db.query(`UPDATE car_holds SET status = 'released', released_at = $2, released_by = $3 WHERE alert_id = $1 AND status <> 'released'`, [p.caseId, at, p.closedBy])
      await touchAlert(db, e, `status = 'closed', closed_at = $4, outcome = $5`, [p.outcome])
      return [{ type: 'alert.updated', alertId: p.caseId }]
    case 'BearingTrendUpdated':
      if (p.excludedPreInstall > 0 && p.features?.previousComponent) return []
      await db.query(
        `INSERT INTO bearing_trends_latest (trip_id, car_id, position, features, tier, passed_at, last_position) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (trip_id, car_id, position) DO UPDATE SET features = EXCLUDED.features, tier = EXCLUDED.tier, passed_at = EXCLUDED.passed_at,
           last_position = EXCLUDED.last_position
         WHERE bearing_trends_latest.last_position < EXCLUDED.last_position`,
        [p.tripId, p.carId, p.position, JSON.stringify(p.features), p.tier, p.passedAt, e.globalPosition],
      )
      return []
    default:
      return []
  }
}
