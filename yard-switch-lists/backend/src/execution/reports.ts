/**
 * Crew reports: what actually happened. Yard state comes from here, never from
 * the plan.
 *
 * - The client generates the report id, so a retry or an offline sync collides on
 *   the primary key and returns the original answer.
 * - A car's position is folded by event time: a report older than the car's last
 *   position change is recorded but doesn't move it, so offline reports that sync
 *   out of order land the car in the same place as if they had arrived in order.
 * - Going as planned doesn't bump the state version. A mismatch does, and queues a replan.
 * - An online start is refused if any car in the move is on hold right now,
 *   whatever the plan says. An offline report is a fact about the past: it's
 *   accepted and raises an alert instead, because refusing it wouldn't undo it.
 * @module execution/reports
 */
import { z } from 'zod'
import type pg from 'pg'
import { HttpError } from '../shared/errors.js'
import { crewReports } from '../shared/metrics.js'
import type { PlanMove } from '../domain/types.js'
import { raiseAlert, readYard, resolveAlert, surprise, type YardRow } from '../plans/state.js'
import { loadMoves } from '../plans/versions.js'

export const crewReportSchema = z.object({
  clientReportId: z.string().min(8).max(100),
  moveKey: z.string().min(1).max(200).nullable().optional(),
  kind: z.enum(['start', 'complete', 'exception']),
  occurredAt: z.string().datetime({ offset: true }).optional(),
  offline: z.boolean().optional(),
  exceptionType: z.enum(['car_not_found', 'track_blocked', 'different_cars']).optional(),
  carIds: z.array(z.string().max(60)).max(200).optional(),
  actualToTrackId: z.string().max(20).optional(),
  trackId: z.string().max(20).optional(),
  note: z.string().max(500).optional(),
})

export type CrewReport = z.infer<typeof crewReportSchema>

export interface ReportResult {
  clientReportId: string
  moveKey: string | null
  outcome: string
  duplicate: boolean
  mismatch: boolean
  message?: string
  stateVersion?: number
}

/** Drift beyond this means later moves are really late, not just a little behind. */
const DRIFT_MINUTES = 25

async function currentMove(client: pg.PoolClient, yard: YardRow, key: string): Promise<PlanMove | null> {
  if (yard.headVersionId) {
    const head = await loadMoves(client, yard.headVersionId)
    const hit = head.find((m) => m.key === key)
    if (hit) return hit
  }
  const { rows } = await client.query(`SELECT move FROM move_executions WHERE shift_id = $1 AND key = $2`, [yard.shiftId, key])
  if (rows[0]?.move) return rows[0].move as PlanMove
  // A report can name a move from an older version the crew was still holding.
  const { rows: older } = await client.query(
    `SELECT m.*, l.version_no FROM moves m JOIN switch_lists l ON l.id = m.list_id WHERE l.shift_id = $1 AND m.key = $2 ORDER BY l.version_no DESC LIMIT 1`,
    [yard.shiftId, key],
  )
  const m = older[0]
  if (!m) return null
  return {
    key: m.key,
    kind: m.kind,
    crew: m.crew,
    carIds: m.car_ids,
    fromTrackId: m.from_track_id,
    toTrackId: m.to_track_id,
    blockId: m.block_id,
    inboundId: m.inbound_id,
    outboundId: m.outbound_id,
    plannedStart: new Date(m.planned_start).getTime(),
    plannedEnd: new Date(m.planned_end).getTime(),
  }
}

async function activeHoldsOn(client: pg.PoolClient, carIds: string[]): Promise<string[]> {
  if (carIds.length === 0) return []
  const { rows } = await client.query(`SELECT DISTINCT car_id FROM car_holds WHERE car_id = ANY($1) AND status IN ('active', 'bad_ordered')`, [carIds])
  return rows.map((r) => r.car_id as string)
}

async function moveCars(client: pg.PoolClient, yard: YardRow, move: PlanMove, carIds: string[], toTrackId: string, at: Date): Promise<void> {
  const trackKind = await client.query(`SELECT kind FROM tracks WHERE id = $1`, [toTrackId])
  const toDeparture = trackKind.rows[0]?.kind === 'departure'
  const coupleTo = toDeparture ? move.outboundId : null
  for (let i = 0; i < carIds.length; i++) {
    const id = carIds[i]
    // Event-time guard: an older report can't move a car backwards.
    const coupledSeq = coupleTo ? at.getTime() * 1000 + i : null
    await client.query(
      `UPDATE cars SET track_id = $2, position = 'on_track', coupled_to = $3, coupled_seq = $4, position_as_of = $5
        WHERE id = $1 AND position <> 'departed' AND (position_as_of IS NULL OR position_as_of <= $5)`,
      [id, toTrackId, coupleTo, coupledSeq, at.toISOString()],
    )
    await client.query(`INSERT INTO car_handlings (shift_id, car_id, move_key, kind, at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [yard.shiftId, id, move.key, move.kind, at.toISOString()])
  }
  // Occupancy from what was reported, against what the track can hold.
  const { rows } = await client.query(
    `SELECT t.capacity_ft, COALESCE(SUM(c.length_ft), 0)::int AS feet FROM tracks t LEFT JOIN cars c ON c.track_id = t.id AND c.position = 'on_track' WHERE t.id = $1 GROUP BY t.capacity_ft`,
    [toTrackId],
  )
  const row = rows[0]
  if (row && row.feet > row.capacity_ft) {
    await client.query(`INSERT INTO capacity_events (shift_id, track_id, over_ft, move_key, at) VALUES ($1, $2, $3, $4, $5)`, [yard.shiftId, toTrackId, row.feet - row.capacity_ft, move.key, at.toISOString()])
    await raiseAlert(client, { dedupKey: `capacity:${yard.shiftId}:${toTrackId}`, kind: 'track_over_capacity', severity: 'warning', message: `${toTrackId} holds ${row.feet} ft against ${row.capacity_ft} ft after ${move.key}, per crew report.`, moveKey: move.key })
  }
}

async function setExecution(client: pg.PoolClient, yard: YardRow, key: string, fields: { status: string; crew?: string; startedAt?: Date | null; completedAt?: Date | null; move?: PlanMove | null; deviated?: boolean }): Promise<void> {
  await client.query(
    `INSERT INTO move_executions (shift_id, key, status, crew_name, started_at, completed_at, move, deviated)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (shift_id, key) DO UPDATE SET status = EXCLUDED.status,
       crew_name = COALESCE(EXCLUDED.crew_name, move_executions.crew_name),
       started_at = COALESCE(move_executions.started_at, EXCLUDED.started_at),
       completed_at = COALESCE(EXCLUDED.completed_at, move_executions.completed_at),
       move = COALESCE(EXCLUDED.move, move_executions.move),
       deviated = move_executions.deviated OR EXCLUDED.deviated,
       updated_at = now()`,
    [yard.shiftId, key, fields.status, fields.crew ?? null, fields.startedAt?.toISOString() ?? null, fields.completedAt?.toISOString() ?? null, fields.move ? JSON.stringify(fields.move) : null, fields.deviated ?? false],
  )
}

export async function applyCrewReport(client: pg.PoolClient, report: CrewReport, reporter: string): Promise<ReportResult> {
  const yard = await readYard(client, true)
  const existing = await client.query(`SELECT response FROM crew_reports WHERE client_report_id = $1`, [report.clientReportId])
  if (existing.rows[0]) {
    crewReports.inc({ kind: report.kind, outcome: 'duplicate' })
    return { ...(existing.rows[0].response as ReportResult), duplicate: true }
  }
  const occurredAt = report.occurredAt ? new Date(report.occurredAt) : yard.simNow
  const offline = Boolean(report.offline)
  const key = report.moveKey ?? null
  const result = await applyByKind(client, yard, report, reporter, occurredAt, offline, key)
  await client.query(
    `INSERT INTO crew_reports (client_report_id, shift_id, move_key, kind, exception_type, payload, reporter, occurred_at, offline, outcome, mismatch, response, state_version_after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, (SELECT state_version FROM yard_state LIMIT 1))`,
    [report.clientReportId, yard.shiftId, key, report.kind, report.exceptionType ?? null, JSON.stringify(report), reporter, occurredAt.toISOString(), offline, result.outcome, result.mismatch, JSON.stringify(result)],
  )
  crewReports.inc({ kind: report.kind, outcome: result.outcome })
  return result
}

async function applyByKind(client: pg.PoolClient, yard: YardRow, report: CrewReport, reporter: string, occurredAt: Date, offline: boolean, key: string | null): Promise<ReportResult> {
  const base = { clientReportId: report.clientReportId, moveKey: key, duplicate: false }
  const ok = (outcome: string, mismatch = false, message?: string, stateVersion?: number): ReportResult => ({ ...base, outcome, mismatch, message, stateVersion })

  if (report.kind === 'exception' && report.exceptionType === 'track_blocked') {
    const trackId = report.trackId ?? (key ? (await currentMove(client, yard, key))?.toTrackId : null)
    if (!trackId) throw new HttpError(422, 'TRACK_REQUIRED', 'Which track is blocked?')
    await client.query(`UPDATE tracks SET is_open = FALSE, blocked_reason = $2, blocked_by = $3, blocked_at = $4 WHERE id = $1`, [trackId, report.note ?? 'reported blocked by crew', reporter, occurredAt.toISOString()])
    if (key) {
      const exec = await client.query(`SELECT status FROM move_executions WHERE shift_id = $1 AND key = $2`, [yard.shiftId, key])
      if (exec.rows[0]?.status === 'in_progress') await setExecution(client, yard, key, { status: 'cancelled', deviated: true })
    }
    const v = await surprise(client, 'crew_exception', { type: 'track_blocked', trackId, moveKey: key, reporter }, reporter)
    await raiseAlert(client, { dedupKey: `track:${trackId}:blocked`, kind: 'track_blocked', severity: 'warning', moveKey: key, message: `${reporter} reported ${trackId} blocked${report.note ? `: ${report.note}` : ''}. Replanning around it.` })
    return ok('applied', true, `${trackId} marked blocked`, v)
  }

  if (!key) throw new HttpError(422, 'MOVE_REQUIRED', 'This report needs a move')
  const move = await currentMove(client, yard, key)
  if (!move) throw new HttpError(404, 'MOVE_NOT_FOUND', `Move ${key} isn't in any plan this shift`)
  const { rows: execRows } = await client.query(`SELECT status, move FROM move_executions WHERE shift_id = $1 AND key = $2`, [yard.shiftId, key])
  const execStatus = (execRows[0]?.status as string) ?? 'pending'
  const planned = (execRows[0]?.move as PlanMove | null) ?? move

  if (report.kind === 'start') {
    if (execStatus === 'done') {
      // The complete synced first. Keep the time, change nothing else.
      await client.query(`UPDATE move_executions SET started_at = LEAST(COALESCE(started_at, $3), $3) WHERE shift_id = $1 AND key = $2`, [yard.shiftId, key, occurredAt.toISOString()])
      return ok('late_noop', false, 'Already reported complete')
    }
    if (execStatus === 'in_progress') return ok('already_started')
    const held = move.kind === 'setout' ? [] : await activeHoldsOn(client, move.carIds)
    if (held.length > 0) {
      if (!offline) {
        await raiseAlert(client, { dedupKey: `start-refused:${key}`, kind: 'start_refused_hold', severity: 'critical', carId: held[0], moveKey: key, message: `${reporter} tried to start ${key}, but ${held.join(', ')} is on hold. The start was refused.` })
        return ok('refused_hold', false, `Stop: ${held.join(', ')} is on hold. Don't move this cut.`)
      }
      await raiseAlert(client, { dedupKey: `start-held:${key}`, kind: 'started_while_held', severity: 'critical', carId: held[0], moveKey: key, message: `${reporter} started ${key} while offline, and ${held.join(', ')} is on hold.` })
    }
    if (!offline && move.fromTrackId) {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM cars WHERE id = ANY($1) AND (track_id IS DISTINCT FROM $2 OR position <> 'on_track')`, [move.carIds, move.fromTrackId])
      if (rows[0].n > 0) return ok('refused_not_ready', false, `${rows[0].n} cars aren't on ${move.fromTrackId} yet`)
    }
    await setExecution(client, yard, key, { status: 'in_progress', crew: reporter, startedAt: occurredAt, move })
    if (offline) {
      const v = await surprise(client, 'offline_sync', { moveKey: key, kind: 'start', reporter }, reporter)
      return ok('applied', false, undefined, v)
    }
    return ok('applied')
  }

  if (report.kind === 'complete') {
    if (execStatus === 'done') return ok('late_noop', false, 'Already complete')
    const held = move.kind === 'assemble' ? await activeHoldsOn(client, planned.carIds) : []
    await moveCars(client, yard, planned, planned.carIds, planned.toTrackId, occurredAt)
    await setExecution(client, yard, key, { status: 'done', crew: reporter, startedAt: occurredAt, completedAt: occurredAt, move: planned })
    if (planned.kind === 'setout') {
      for (const id of planned.carIds) {
        await client.query(`UPDATE alerts SET status = 'resolved', resolved_at = now() WHERE car_id = $1 AND kind = 'hold_after_coupling' AND status <> 'resolved'`, [id])
      }
    }
    let version: number | undefined
    if (held.length > 0) {
      await raiseAlert(client, { dedupKey: `coupled-held:${held[0]}`, kind: 'hold_after_coupling', severity: 'critical', carId: held[0], outboundId: move.outboundId, moveKey: key, message: `${held.join(', ')} is on hold and was just coupled to ${move.outboundId}. It must be set out.` })
      version = await surprise(client, 'hold_coupled', { moveKey: key, cars: held }, reporter)
    }
    const lateMin = (occurredAt.getTime() - planned.plannedEnd) / 60_000
    if (offline) version = await surprise(client, 'offline_sync', { moveKey: key, kind: 'complete', reporter }, reporter)
    else if (lateMin > DRIFT_MINUTES) version = await surprise(client, 'execution_drift', { moveKey: key, lateMin: Math.round(lateMin) }, reporter)
    return ok('applied', false, undefined, version)
  }

  // Exceptions: the state follows the report, then the plan follows the state.
  if (report.exceptionType === 'car_not_found') {
    const cars = report.carIds?.length ? report.carIds : planned.carIds
    await client.query(
      `UPDATE cars SET position = 'unknown', track_id = NULL, coupled_to = NULL, position_as_of = $2 WHERE id = ANY($1) AND position <> 'departed' AND (position_as_of IS NULL OR position_as_of <= $2)`,
      [cars, occurredAt.toISOString()],
    )
    if (execStatus === 'in_progress') await setExecution(client, yard, key, { status: 'cancelled', deviated: true })
    await raiseAlert(client, { dedupKey: `missing:${yard.shiftId}:${cars[0]}`, kind: 'car_not_found', severity: 'warning', carId: cars[0], moveKey: key, message: `${reporter} couldn't find ${cars.join(', ')} on ${planned.fromTrackId ?? 'the expected track'}. Those cars are out of the plan until found.` })
    const v = await surprise(client, 'crew_exception', { type: 'car_not_found', cars, moveKey: key, reporter }, reporter)
    return ok('applied', true, `${cars.length} cars marked not found`, v)
  }
  if (report.exceptionType === 'different_cars') {
    const actual = report.carIds?.length ? report.carIds : planned.carIds
    const toTrack = report.actualToTrackId ?? planned.toTrackId
    const moved: PlanMove = { ...planned, carIds: actual, toTrackId: toTrack }
    await moveCars(client, yard, moved, actual, toTrack, occurredAt)
    await setExecution(client, yard, key, { status: 'done', crew: reporter, startedAt: occurredAt, completedAt: occurredAt, move: moved, deviated: true })
    const v = await surprise(client, 'crew_exception', { type: 'different_cars', planned: planned.carIds, actual, toTrack, moveKey: key, reporter }, reporter)
    await raiseAlert(client, { dedupKey: `different:${yard.shiftId}:${key}`, kind: 'different_cars', severity: 'warning', moveKey: key, message: `${reporter} moved different cars than ${key} said: ${actual.length} cars to ${toTrack}, planned ${planned.carIds.length} to ${planned.toTrackId}. The board now shows what was reported.` })
    return ok('applied', true, 'State updated from the report', v)
  }
  throw new HttpError(422, 'EXCEPTION_TYPE_REQUIRED', 'An exception needs a type')
}

export { resolveAlert }
