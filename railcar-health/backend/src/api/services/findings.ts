/**
 * Recording an inspection finding, and the component installs that repairs
 * produce. The yard tablet may be offline, so it generates a
 * clientSubmissionId when the form opens and resends the same one until it
 * gets an answer: a replay returns the stored finding.
 *
 * Inspected is not closed. A finding moves the alert to "inspected"; it is
 * closed when the car is released (no defect found), or repaired (a new
 * wheelset installed, recorded with its install time). A bad-ordered car stays
 * "inspected" with its hold in place until the repair is recorded.
 * @module api/services/findings
 */
import type pg from 'pg'
import { z } from 'zod'
import { canActOnYard, type SessionUser } from '../../shared/auth.js'
import { now } from '../../shared/clock.js'
import { withTransaction } from '../../shared/db.js'
import { DISPOSITIONS, FINDINGS, isBrakeKind } from '../../shared/domain.js'
import { HttpError, notFound } from '../../shared/errors.js'
import type { LiveEvent } from '../../shared/events.js'

const isoDate = z.string().datetime({ offset: true })

export const replacementSchema = z.object({
  componentId: z.string().min(3).max(40),
  installedAt: isoDate,
  axle: z.number().int().min(1).max(12).optional(),
})

export const findingSchema = z
  .object({
    clientSubmissionId: z.string().min(8).max(100),
    finding: z.enum(FINDINGS),
    disposition: z.enum(DISPOSITIONS),
    notes: z.string().max(1000).optional(),
    observedAt: isoDate.optional(),
    replacement: replacementSchema.optional(),
  })
  .refine((f) => f.finding === 'no_defect_found' || f.disposition !== 'release', {
    message: 'A car with a confirmed defect must be bad-ordered or repaired, not released',
    path: ['disposition'],
  })
  .refine((f) => f.disposition !== 'repaired' || f.replacement !== undefined, {
    message: 'A repair must record the replacement wheelset (component id and install time)',
    path: ['replacement'],
  })

export const installSchema = z.object({
  clientSubmissionId: z.string().min(8).max(100),
  axle: z.number().int().min(1).max(12),
  componentId: z.string().min(3).max(40),
  installedAt: isoDate,
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

/**
 * Records a wheelset install as an event: the previous wheelset on that axle is
 * closed at the install's event time. Then any inspected alert for that axle's
 * bearings on this car is closed and its bad-order hold released.
 */
export async function recordInstall(
  client: pg.PoolClient,
  input: { carId: string; axle: number; componentId: string; installedAt: string; recordedBy: string; findingId?: string; clientSubmissionId?: string },
): Promise<{ installId: string; closedAlerts: Array<{ id: string; trip_id: string; yard_id: string | null }>; replayed: boolean }> {
  if (input.clientSubmissionId) {
    const prior = await client.query<{ id: string }>('SELECT id FROM component_installs WHERE client_submission_id = $1', [input.clientSubmissionId])
    if (prior.rows[0]) return { installId: prior.rows[0].id, closedAlerts: [], replayed: true }
  }
  const at = now()
  await client.query(
    `UPDATE component_installs SET removed_at = $3 WHERE car_id = $1 AND axle = $2 AND removed_at IS NULL AND installed_at < $3`,
    [input.carId, input.axle, input.installedAt],
  )
  const current = await client.query('SELECT 1 FROM component_installs WHERE car_id = $1 AND axle = $2 AND removed_at IS NULL', [input.carId, input.axle])
  if (current.rowCount) throw new HttpError(409, 'NEWER_INSTALL_EXISTS', 'A wheelset installed later than this one is already recorded on that axle')
  const ins = await client.query<{ id: string }>(
    `INSERT INTO component_installs (car_id, axle, component_id, installed_at, recorded_at, recorded_by, finding_id, client_submission_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [input.carId, input.axle, input.componentId, input.installedAt, at, input.recordedBy, input.findingId ?? null, input.clientSubmissionId ?? null],
  )
  const closed = await client.query<{ id: string; trip_id: string; yard_id: string | null }>(
    `UPDATE alerts SET status = 'closed', closed_at = $3, updated_at = $3, version = version + 1, outcome = COALESCE(outcome, 'repaired')
      WHERE car_id = $1 AND kind = 'hot_bearing' AND substring(position from 2)::int = $2 AND status = 'inspected'
      RETURNING id, trip_id, yard_id`,
    [input.carId, input.axle, at],
  )
  for (const a of closed.rows) {
    await client.query(`UPDATE car_holds SET status = 'released', released_at = $2, released_by = $3 WHERE alert_id = $1 AND status <> 'released'`, [a.id, at, input.recordedBy])
    await client.query(`INSERT INTO alert_events (alert_id, kind, note, actor, at) VALUES ($1, 'closed', $2, $3, $4) ON CONFLICT DO NOTHING`, [
      a.id, `Wheelset ${input.componentId} installed on axle ${input.axle} at ${input.installedAt}; car repaired`, input.recordedBy, at,
    ])
  }
  return { installId: ins.rows[0].id, closedAlerts: closed.rows, replayed: false }
}

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
    const audit = wo.alert_id === null
    const inserted = await client.query(
      `INSERT INTO findings (client_submission_id, work_order_id, alert_id, car_id, position, source, finding, disposition, notes, recorded_by, observed_at, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [input.clientSubmissionId, workOrderId, wo.alert_id, wo.car_id, wo.position, audit ? 'audit' : 'alert', input.finding, input.disposition,
        input.notes ?? null, user.username, input.observedAt ?? at, at],
    )
    const finding = toRecord(inserted.rows[0])
    await client.query(
      `UPDATE work_orders SET status = 'completed', completed_at = $2, assigned_to = COALESCE(assigned_to, $3), version = version + 1 WHERE id = $1`,
      [workOrderId, at, user.username],
    )
    const events: LiveEvent[] = [{ type: 'workorder.updated', yardId: wo.yard_id, alertId: wo.alert_id ?? undefined, carId: wo.car_id }]
    if (input.replacement) {
      const axle = input.replacement.axle ?? (/^[LR]\d$/.test(wo.position) ? Number(wo.position.slice(1)) : null)
      if (axle === null) throw new HttpError(422, 'AXLE_REQUIRED', 'Say which axle the replacement wheelset went on')
      await recordInstall(client, { carId: wo.car_id, axle, componentId: input.replacement.componentId, installedAt: input.replacement.installedAt, recordedBy: user.username, findingId: finding.id })
    }
    if (audit) return { finding, replayed: false, events }

    // Inspected now; closed too unless the car is bad-ordered and still waiting for its repair.
    const closesNow = input.disposition !== 'bad_order'
    const alert = (
      await client.query(
        `UPDATE alerts SET status = $2, outcome = $3, inspected_at = $4, closed_at = CASE WHEN $2 = 'closed' THEN $4::timestamptz ELSE closed_at END,
                updated_at = $4, version = version + 1
          WHERE id = $1 RETURNING id, trip_id, desk_id, yard_id, car_id, kind`,
        [wo.alert_id, closesNow ? 'closed' : 'inspected', input.finding, at],
      )
    ).rows[0]
    const holdStatus = input.disposition === 'bad_order' ? 'bad_ordered' : 'released'
    await client.query(
      `UPDATE car_holds SET status = $2, released_at = CASE WHEN $2 = 'released' THEN $3::timestamptz ELSE NULL END, released_by = $4 WHERE alert_id = $1`,
      [wo.alert_id, holdStatus, at, user.username],
    )
    await client.query(`INSERT INTO alert_events (alert_id, kind, note, actor, at) VALUES ($1, 'inspected', $2, $3, $4) ON CONFLICT DO NOTHING`, [
      wo.alert_id, `${input.finding.replace(/_/g, ' ')}; ${input.disposition.replace('_', ' ')}${isBrakeKind(alert.kind) ? ' (brake inspection)' : ''}`, user.username, at,
    ])
    if (closesNow) {
      await client.query(`INSERT INTO alert_events (alert_id, kind, note, actor, at) VALUES ($1, 'closed', $2, $3, $4) ON CONFLICT DO NOTHING`, [
        wo.alert_id, input.disposition === 'repaired' ? 'Repaired on the spot and released' : 'Released to service', user.username, at,
      ])
    }
    const owner = (await client.query('SELECT owner_mark FROM railcars WHERE car_id = $1', [wo.car_id])).rows[0]
    if (owner) {
      await client.query(
        `INSERT INTO notifications (alert_id, channel, target, kind, message, dedupe_key, created_at)
         VALUES ($1, 'car_owner', $2, 'finding', $3, $4, $5) ON CONFLICT (dedupe_key) DO NOTHING`,
        [wo.alert_id, owner.owner_mark, `Inspection of ${wo.car_id} ${wo.position}: ${input.finding.replace(/_/g, ' ')}, ${input.disposition.replace('_', ' ')}`,
          `${wo.alert_id}:car_owner:finding`, at],
      )
    }
    events.push({ type: 'alert.updated', alertId: alert.id, tripId: alert.trip_id, yardId: alert.yard_id, deskId: alert.desk_id })
    return { finding, replayed: false, events }
  })
}
