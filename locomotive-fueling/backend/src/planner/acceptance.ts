/**
 * Plan acceptance. A recommendation reserves nothing. Accepting it (fuel desk
 * on the dashboard, or the crew on the cab tablet) turns each stop into a
 * commitment that holds a bay at the pad for its slot window, with an expiry,
 * and makes DTL stops eligible for a truck order. Confirming a proposal does
 * the same for the replacement plan and releases what the old plan held.
 *
 * Capacity is enforced at acceptance, serialized per fuel option with a row
 * lock: first to accept gets the bay; the second gets 409 SLOT_TAKEN and a
 * re-plan that now sees the queue at that pad.
 * @module planner/acceptance
 */
import { loadParams } from '../shared/repo.js'
import { pool, withTransaction } from '../shared/db.js'
import { HttpError, notFound } from '../shared/errors.js'
import { publishEvent } from '../shared/events.js'
import { raiseAlert } from '../shared/alerts.js'
import { simNow } from '../shared/sim-clock.js'
import { enqueuePlan } from '../shared/triggers.js'
import { fits } from './capacity.js'

export type AcceptMode = 'accept' | 'confirm'

export interface AcceptResult {
  version: number
  reservations: { stopKey: string; optionId: string; slotStart: string; slotEnd: string; expiresAt: string }[]
}

export async function acceptPlan(trainId: string, version: number, actor: string, mode: AcceptMode): Promise<AcceptResult> {
  const params = await loadParams()
  const now = await simNow()
  let conflict: { optionId: string; symbol: string } | null = null
  try {
    const result = await withTransaction(async (db) => {
      const { rows } = await db.query<{ id: string; lifecycle: string; isCurrent: boolean; symbol: string }>(
        `SELECT p.id, p.lifecycle, p.is_current AS "isCurrent", t.symbol FROM fuel_plans p JOIN trains t ON t.id = p.train_id
          WHERE p.train_id = $1 AND p.version = $2 FOR UPDATE OF p`,
        [trainId, version],
      )
      const plan = rows[0]
      if (!plan) throw notFound('Plan version')
      if (mode === 'accept' && !(plan.isCurrent && plan.lifecycle === 'recommended')) {
        throw new HttpError(409, 'NOT_ACCEPTABLE', plan.lifecycle === 'accepted' ? 'Plan is already accepted' : 'Only the current recommended plan can be accepted')
      }
      if (mode === 'confirm' && plan.lifecycle !== 'proposed') throw new HttpError(409, 'NOT_PROPOSED', 'This version is not a pending proposal')

      const { rows: stops } = await db.query<{ stopKey: string; optionId: string; locationId: string; eta: Date; dwell: number; bays: number }>(
        `SELECT s.stop_key AS "stopKey", s.option_id AS "optionId", s.location_id AS "locationId", s.eta, s.dwell_minutes AS dwell, f.bays
           FROM plan_stops s JOIN fuel_options f ON f.id = s.option_id WHERE s.plan_id = $1 ORDER BY s.seq`,
        [plan.id],
      )
      const reservations: AcceptResult['reservations'] = []
      for (const s of stops) {
        // Serialize acceptances per option, then check the bays across the slot window.
        await db.query('SELECT id FROM fuel_options WHERE id = $1 FOR UPDATE', [s.optionId])
        const start = s.eta.getTime()
        const end = start + s.dwell * 60_000
        const { rows: taken } = await db.query<{ start: Date; end: Date }>(
          `SELECT slot_start AS start, slot_end AS "end" FROM stop_commitments
            WHERE option_id = $1 AND state IN ('accepted', 'executing') AND train_id <> $2`,
          [s.optionId, trainId],
        )
        if (!fits(taken.map((t) => ({ start: t.start.getTime(), end: t.end.getTime() })), start, end, s.bays)) {
          conflict = { optionId: s.optionId, symbol: plan.symbol }
          throw new HttpError(409, 'SLOT_TAKEN', `Every bay at ${s.optionId} is reserved around this train's arrival; re-planning`)
        }
        const expires = new Date(end + params.reservationGraceHours * 3_600_000)
        await db.query(
          `INSERT INTO stop_commitments (stop_key, train_id, location_id, option_id, plan_version, state, slot_start, slot_end, expires_at, accepted_by)
           VALUES ($1, $2, $3, $4, $5, 'accepted', $6, $7, $8, $9)
           ON CONFLICT (stop_key) DO UPDATE SET plan_version = EXCLUDED.plan_version, state = 'accepted', slot_start = EXCLUDED.slot_start,
             slot_end = EXCLUDED.slot_end, expires_at = EXCLUDED.expires_at, accepted_by = EXCLUDED.accepted_by, note = NULL, updated_at = now()
           WHERE stop_commitments.state IN ('accepted', 'cancelled', 'expired')`,
          [s.stopKey, trainId, s.locationId, s.optionId, version, new Date(start), new Date(end), expires, actor],
        )
        reservations.push({ stopKey: s.stopKey, optionId: s.optionId, slotStart: new Date(start).toISOString(), slotEnd: new Date(end).toISOString(), expiresAt: expires.toISOString() })
      }

      if (mode === 'confirm') {
        await db.query(`UPDATE fuel_plans SET is_current = false, lifecycle = 'superseded' WHERE train_id = $1 AND is_current`, [trainId])
        await db.query(`UPDATE fuel_plans SET is_current = true, lifecycle = 'accepted', accepted_by = $2, accepted_at = $3 WHERE id = $1`, [plan.id, actor, now])
      } else {
        await db.query(`UPDATE fuel_plans SET lifecycle = 'accepted', accepted_by = $2, accepted_at = $3 WHERE id = $1`, [plan.id, actor, now])
      }
      // Anything the train had reserved that this plan doesn't use is released.
      const keep = stops.map((s) => s.stopKey)
      await db.query(
        `UPDATE stop_commitments SET state = 'cancelled', note = $3, updated_at = now() WHERE train_id = $1 AND state = 'accepted' AND NOT (stop_key = ANY($2))`,
        [trainId, keep, `Released when v${version} was ${mode === 'confirm' ? 'confirmed' : 'accepted'}`],
      )
      // The fuel desk or crew has acted: pending proposal and "plan voided" alerts are settled.
      await db.query(
        `UPDATE alerts SET status = 'resolved', resolved_at = $2 WHERE train_id = $1 AND type IN ('plan_proposal', 'plan_voided', 'slot_conflict') AND status <> 'resolved'`,
        [trainId, now],
      )
      return { version, reservations }
    })
    // The planner places truck orders for accepted DTL stops and cancels orders for released ones.
    await enqueuePlan(trainId, 'accepted', `v${version} ${mode === 'confirm' ? 'confirmed' : 'accepted'} by ${actor}`)
    await publishEvent({ type: 'plan', trainId, id: version, note: mode })
    return result
  } catch (err) {
    if (conflict) {
      const c = conflict as { optionId: string; symbol: string }
      await raiseAlert(
        { type: 'slot_conflict', severity: 'warning', trainId, locomotiveId: null, dedupKey: `slot_conflict:${trainId}:${c.optionId}`, message: `${c.symbol}: could not reserve a bay at ${c.optionId}; re-planning around the queue.` },
        now,
      )
      await enqueuePlan(trainId, 'slot_conflict', c.optionId)
    }
    throw err
  }
}

export async function rejectProposal(trainId: string, version: number, actor: string): Promise<void> {
  const res = await pool.query(`UPDATE fuel_plans SET lifecycle = 'rejected', reason = reason || $3 WHERE train_id = $1 AND version = $2 AND lifecycle = 'proposed'`, [
    trainId,
    version,
    ` (rejected by ${actor})`,
  ])
  if (!res.rowCount) throw new HttpError(409, 'NOT_PROPOSED', 'This version is not a pending proposal')
  await pool.query(`UPDATE alerts SET status = 'resolved', resolved_at = $2 WHERE dedup_key = $1 AND status <> 'resolved'`, [`plan_proposal:${trainId}`, await simNow()])
  await publishEvent({ type: 'plan', trainId, id: version, note: 'rejected' })
}

/** Releases reservations whose train never showed up; those trains are re-planned. */
export async function expireReservations(): Promise<number> {
  const now = await simNow()
  const { rows } = await pool.query<{ trainId: string; optionId: string }>(
    `UPDATE stop_commitments SET state = 'expired', note = 'Train did not arrive within the grace period', updated_at = now()
      WHERE state = 'accepted' AND expires_at < $1 RETURNING train_id AS "trainId", option_id AS "optionId"`,
    [now],
  )
  for (const r of rows) await enqueuePlan(r.trainId, 'reservation_expired', r.optionId)
  return rows.length
}
