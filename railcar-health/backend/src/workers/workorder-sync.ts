/**
 * Work-order integration (choreography). Reacts to facts and records its own:
 *  - WorkOrderOpened            -> a ticket in the yard maintenance system (simulated: mro_tickets)
 *  - InspectionFindingRecorded  -> if the car was repaired on the spot, ComponentReplaced on the car's stream
 *  - ComponentReplaced          -> closes inspected (bad-ordered) cases on that axle: repaired, hold released
 *  - CaseClosed                 -> closes the ticket
 *  - TripArrived                -> opens the random audit case for the arriving train (label-bias guard)
 * Nobody calls it and it calls nobody: if it is down, these effects wait in its
 * consumer group and happen when it comes back.
 * @module workers/workorder-sync
 */
import type { Handler } from '../events/consumer.js'
import { uuidFromName } from '../shared/ids.js'
import { decideClose, decideOpenWorkOrder } from '../domain/case.js'
import { decideReplaceComponent } from '../domain/car.js'
import { loadCar, loadCase, loadCases, openCaseIds, stageCar, stageCase, syncCaseIndex } from '../domain/repository.js'
import type { Queryable } from '../shared/db.js'

type P = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

export const workOrderSyncHandler: Handler = async (event, { client, batch }) => {
  const p = event.payload as P
  switch (event.type) {
    case 'WorkOrderOpened':
      await client.query(
        `INSERT INTO mro_tickets (work_order_id, case_id, external_ref, yard_id, status, opened_at) VALUES ($1, $2, $3, $4, 'open', $5) ON CONFLICT DO NOTHING`,
        [p.workOrderId, p.caseId, `MRO-${p.yardId}-${String(p.workOrderId).slice(0, 8).toUpperCase()}`, p.yardId, event.occurredAt],
      )
      return undefined
    case 'CaseClosed':
      await client.query(`UPDATE mro_tickets SET status = 'closed', closed_at = $2 WHERE case_id = $1 AND status = 'open'`, [p.caseId, event.occurredAt])
      return undefined
    case 'InspectionFindingRecorded': {
      if (!p.replacement || !p.caseId) return undefined
      const car = await loadCar(client, p.carId)
      const decision = decideReplaceComponent(car, {
        axle: p.replacement.axle, componentId: p.replacement.componentId, installedAt: p.replacement.installedAt, recordedBy: p.recordedBy,
        findingId: p.findingId, caseId: p.caseId, clientSubmissionId: null,
      })
      if (decision.kind === 'recorded') stageCar(batch, car, decision.events)
      return { notices: [{ type: 'trip.updated', carId: p.carId }] }
    }
    case 'ComponentReplaced': {
      const cases = await loadCases(client, await openCaseIds(client, { carId: p.carId }))
      const notices = []
      for (const s of cases) {
        if (s.status !== 'inspected' || s.kind !== 'hot_bearing' || Number(s.position?.slice(1)) !== Number(p.axle)) continue
        const after = stageCase(batch, s, decideClose(s, {
          reason: 'repaired', outcome: s.outcome ?? 'repaired', by: p.recordedBy, at: new Date(event.recordedAt),
          note: `Wheelset ${p.installedComponentId} installed on axle ${p.axle} at ${p.installedAt}; car repaired`,
        }))
        await syncCaseIndex(client, after)
        notices.push({ type: 'alert.updated' as const, alertId: s.caseId, tripId: s.tripId ?? undefined, yardId: s.yardId })
      }
      return { notices }
    }
    case 'TripArrived': {
      // Derived from the trip id: a redelivered arrival finds the case already there.
      const caseId = uuidFromName(`audit:${p.tripId}`)
      const existing = await loadCase(client, caseId)
      if (existing.exists) return undefined
      const carId = await pickAuditCar(client, p.tripId)
      if (!carId) return undefined
      const s = stageCase(batch, existing, decideOpenWorkOrder(existing, { caseType: 'audit', tripId: p.tripId, carId, position: 'ALL', kind: 'audit', yardId: p.yardId, priority: 0, at: p.arrivedAt }))
      await syncCaseIndex(client, s)
      return { notices: [{ type: 'workorder.updated', yardId: p.yardId }] }
    }
    default:
      return undefined
  }
}

/**
 * Label-bias guard: only flagged cars get inspected, so findings alone can't
 * show what the alerts miss. Each arriving train gets one random audit
 * inspection of a car with no open case. The pick is a hash of the trip id, so
 * a redelivered arrival picks the same car (and the audit case id is derived
 * from the trip id, so it is created once).
 */
export async function pickAuditCar(client: Queryable, tripId: string): Promise<string | null> {
  const { rows } = await client.query<{ unit_id: string }>(
    `SELECT unit_id FROM current_trip_units u
      WHERE u.trip_id = $1 AND u.unit_type = 'car'
        AND NOT EXISTS (SELECT 1 FROM case_index c WHERE c.trip_id = $1 AND c.car_id = u.unit_id AND c.is_open)
      ORDER BY u.position`,
    [tripId],
  )
  if (rows.length === 0) return null
  let h = 0
  for (const ch of tripId) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return rows[h % rows.length].unit_id
}
