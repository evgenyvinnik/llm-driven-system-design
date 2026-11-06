/**
 * reliability projection: one fact row per case (alert or audit) and per
 * stand-alone finding (routine inspection, bearing-shop teardown): the shape the
 * precision/recall queries want. A superseding finding (a defect reported by a
 * second tablet after a "no defect") replaces the label: the more severe wins.
 * @module workers/projections/reliability
 */
import type { Queryable } from '../../shared/db.js'
import type { LiveEvent } from '../../shared/events.js'
import type { EventEnvelope } from '../../events/envelope.js'

type P = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

export async function applyReliability(db: Queryable, e: EventEnvelope): Promise<LiveEvent[]> {
  const p = e.payload as P
  switch (e.type) {
    case 'AlertRaised':
      await db.query(
        `INSERT INTO reliability_facts (fact_id, source, trip_id, car_id, alert_kind, max_tier, opened_at, status) VALUES ($1, 'alert', $2, $3, $4, $5, $6, 'open')
         ON CONFLICT (fact_id) DO NOTHING`,
        [p.caseId, p.tripId, p.carId, p.kind, p.tier, e.occurredAt],
      )
      break
    case 'AlertEscalated':
      await db.query(`UPDATE reliability_facts SET max_tier = GREATEST(max_tier, $2), status = CASE WHEN $3 THEN 'open' ELSE status END WHERE fact_id = $1`, [p.caseId, p.toTier, p.reopened])
      break
    case 'AlertHandedOff':
      await db.query(`UPDATE reliability_facts SET status = 'open' WHERE fact_id = $1 AND status = 'acknowledged'`, [p.caseId])
      break
    case 'AlertAcknowledged':
      await db.query(`UPDATE reliability_facts SET first_ack_at = COALESCE(first_ack_at, $2), status = 'acknowledged' WHERE fact_id = $1`, [p.caseId, e.occurredAt])
      break
    case 'AckDeadlineMissed':
      await db.query('UPDATE reliability_facts SET escalations = escalations + 1 WHERE fact_id = $1', [p.caseId])
      break
    case 'WorkOrderOpened':
      if (p.caseType === 'audit') {
        await db.query(
          `INSERT INTO reliability_facts (fact_id, source, trip_id, car_id, opened_at, status) VALUES ($1, 'audit', $2, $3, $4, 'open') ON CONFLICT (fact_id) DO NOTHING`,
          [p.caseId, p.tripId, p.carId, e.occurredAt],
        )
      }
      break
    case 'InspectionFindingRecorded':
      if (p.caseId) {
        await db.query(`UPDATE reliability_facts SET finding = $2, disposition = $3, status = 'inspected', closed_at = NULL WHERE fact_id = $1`, [p.caseId, p.finding, p.disposition])
      } else {
        await db.query(
          `INSERT INTO reliability_facts (fact_id, source, car_id, opened_at, finding, disposition, status, closed_at) VALUES ($1, $2, $3, $4, $5, $6, 'closed', $4)
           ON CONFLICT (fact_id) DO NOTHING`,
          [p.findingId, p.source, p.carId, p.observedAt, p.finding, p.disposition],
        )
      }
      break
    case 'CaseClosed':
      await db.query(`UPDATE reliability_facts SET status = 'closed', outcome = $2, closed_at = $3 WHERE fact_id = $1`, [p.caseId, p.outcome, e.occurredAt])
      break
  }
  return []
}
