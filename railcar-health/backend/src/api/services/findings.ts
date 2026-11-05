/**
 * Recording an inspection finding. The yard tablet may be offline, so it
 * generates a clientSubmissionId when the form opens and resends the same one
 * until it gets an answer: a replay returns the stored finding. One finding per
 * work order; the effects (work order completed, alert closed, hold released or
 * kept as bad-ordered, owner notified) commit together.
 * @module api/services/findings
 */
import { z } from 'zod'
import { canActOnYard, type SessionUser } from '../../shared/auth.js'
import { now } from '../../shared/clock.js'
import { withTransaction } from '../../shared/db.js'
import { DISPOSITIONS, FINDINGS } from '../../shared/domain.js'
import { HttpError, notFound } from '../../shared/errors.js'
import type { LiveEvent } from '../../shared/events.js'

export const findingSchema = z
  .object({
    clientSubmissionId: z.string().min(8).max(100),
    finding: z.enum(FINDINGS),
    disposition: z.enum(DISPOSITIONS),
    notes: z.string().max(1000).optional(),
    observedAt: z.string().datetime({ offset: true }).optional(),
  })
  .refine((f) => f.finding === 'no_defect_found' || f.disposition === 'bad_order', {
    message: 'A car with a confirmed defect must be bad-ordered, not released',
    path: ['disposition'],
  })

export type FindingInput = z.infer<typeof findingSchema>

export interface FindingRecord {
  id: string
  workOrderId: string
  finding: string
  disposition: string
  notes: string | null
  recordedBy: string
  recordedAt: Date
}

const toRecord = (r: { id: string; work_order_id: string; finding: string; disposition: string; notes: string | null; recorded_by: string; recorded_at: Date }): FindingRecord => ({
  id: r.id, workOrderId: r.work_order_id, finding: r.finding, disposition: r.disposition, notes: r.notes, recordedBy: r.recorded_by, recordedAt: r.recorded_at,
})

export async function recordFinding(workOrderId: string, input: FindingInput, user: SessionUser): Promise<{ finding: FindingRecord; replayed: boolean; events: LiveEvent[] }> {
  return withTransaction(async (client) => {
    const prior = await client.query('SELECT * FROM findings WHERE client_submission_id = $1', [input.clientSubmissionId])
    if (prior.rows[0]) {
      if (prior.rows[0].work_order_id !== workOrderId) throw new HttpError(409, 'SUBMISSION_ID_REUSED', 'This submission id belongs to another work order')
      return { finding: toRecord(prior.rows[0]), replayed: true, events: [] }
    }
    const wo = (await client.query('SELECT * FROM work_orders WHERE id = $1 FOR UPDATE', [workOrderId]).catch(() => ({ rows: [] }))).rows[0]
    if (!wo) throw notFound('Work order')
    if (!canActOnYard(user, wo.yard_id)) throw new HttpError(403, 'FORBIDDEN', 'This work order belongs to another yard')
    if (wo.status === 'completed' || wo.status === 'cancelled') {
      const existing = await client.query('SELECT * FROM findings WHERE work_order_id = $1', [workOrderId])
      throw new HttpError(409, 'ALREADY_COMPLETED', `Work order is already ${wo.status}`, { finding: existing.rows[0] ? toRecord(existing.rows[0]) : null })
    }
    const at = now()
    const inserted = await client.query(
      `INSERT INTO findings (client_submission_id, work_order_id, alert_id, car_id, position, source, finding, disposition, notes, recorded_by, observed_at, recorded_at)
       VALUES ($1, $2, $3, $4, $5, 'alert', $6, $7, $8, $9, $10, $11) RETURNING *`,
      [input.clientSubmissionId, workOrderId, wo.alert_id, wo.car_id, wo.position, input.finding, input.disposition, input.notes ?? null, user.username,
        input.observedAt ?? at, at],
    )
    await client.query(
      `UPDATE work_orders SET status = 'completed', completed_at = $2, assigned_to = COALESCE(assigned_to, $3), version = version + 1 WHERE id = $1`,
      [workOrderId, at, user.username],
    )
    const alert = (
      await client.query(
        `UPDATE alerts SET status = 'closed', outcome = $2, closed_at = $3, updated_at = $3, version = version + 1 WHERE id = $1 RETURNING id, trip_id, desk_id, yard_id, car_id`,
        [wo.alert_id, input.finding, at],
      )
    ).rows[0]
    const holdStatus = input.disposition === 'bad_order' ? 'bad_ordered' : 'released'
    await client.query(
      `UPDATE car_holds SET status = $2, released_at = CASE WHEN $2 = 'released' THEN $3::timestamptz ELSE NULL END, released_by = $4 WHERE alert_id = $1`,
      [wo.alert_id, holdStatus, at, user.username],
    )
    await client.query(`INSERT INTO alert_events (alert_id, kind, note, actor, at) VALUES ($1, 'closed', $2, $3, $4) ON CONFLICT DO NOTHING`, [
      wo.alert_id, `${input.finding}; ${input.disposition}`, user.username, at,
    ])
    const owner = (await client.query('SELECT owner_mark FROM railcars WHERE car_id = $1', [wo.car_id])).rows[0]
    if (owner) {
      await client.query(
        `INSERT INTO notifications (alert_id, channel, target, kind, message, dedupe_key, created_at)
         VALUES ($1, 'car_owner', $2, 'finding', $3, $4, $5) ON CONFLICT (dedupe_key) DO NOTHING`,
        [wo.alert_id, owner.owner_mark, `Inspection of ${wo.car_id} ${wo.position}: ${input.finding.replace(/_/g, ' ')}, ${input.disposition.replace('_', ' ')}`,
          `${wo.alert_id}:car_owner:finding`, at],
      )
    }
    return {
      finding: toRecord(inserted.rows[0]),
      replayed: false,
      events: [
        { type: 'workorder.updated', yardId: wo.yard_id, alertId: wo.alert_id, carId: wo.car_id },
        { type: 'alert.updated', alertId: alert.id, tripId: alert.trip_id, yardId: alert.yard_id, deskId: alert.desk_id },
      ],
    }
  })
}
