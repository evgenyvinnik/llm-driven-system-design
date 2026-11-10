/**
 * The yard-state ledger. Every surprise bumps `state_version`, with a log row
 * saying what happened and who said so, and usually queues a replan trigger.
 * The row lock on yard_state is what serializes publishes against new facts.
 * @module plans/state
 */
import type { Queryable } from '../shared/db.js'

export const YARD_ID = 'SANDHILLS'

export interface YardRow {
  shiftId: number
  seed: number
  stateVersion: number
  simNow: Date
  headVersionId: string | null
  workingVersionId: string | null
  autoPublish: boolean
  plannerSettings: { timeLimitMs?: number; iterations?: number; deterministic?: boolean }
}

function mapYard(row: Record<string, unknown>): YardRow {
  return {
    shiftId: Number(row.shift_id),
    seed: Number(row.seed),
    stateVersion: Number(row.state_version),
    simNow: row.sim_now as Date,
    headVersionId: (row.head_version_id as string) ?? null,
    workingVersionId: (row.working_version_id as string) ?? null,
    autoPublish: Boolean(row.auto_publish),
    plannerSettings: (row.planner_settings ?? {}) as YardRow['plannerSettings'],
  }
}

export async function readYard(db: Queryable, lock = false): Promise<YardRow> {
  const { rows } = await db.query(`SELECT * FROM yard_state WHERE yard_id = $1 ${lock ? 'FOR UPDATE' : ''}`, [YARD_ID])
  if (!rows[0]) throw new Error('yard_state is empty: run db:seed')
  return mapYard(rows[0])
}

/** Records a surprise. Returns the new version. Call inside the transaction that wrote the fact. */
export async function bumpState(db: Queryable, kind: string, detail: Record<string, unknown>, actor: string): Promise<number> {
  const { rows } = await db.query<{ state_version: string; shift_id: number; sim_now: Date }>(
    `UPDATE yard_state SET state_version = state_version + 1, updated_at = now() WHERE yard_id = $1 RETURNING state_version, shift_id, sim_now`,
    [YARD_ID],
  )
  const row = rows[0]
  const version = Number(row.state_version)
  await db.query(`INSERT INTO yard_state_log (version, shift_id, kind, detail, actor, sim_at) VALUES ($1, $2, $3, $4, $5, $6)`, [version, row.shift_id, kind, JSON.stringify(detail), actor, row.sim_now])
  return version
}

/** Queues a replan. The coalescer turns a burst of these into one solve. */
export async function addTrigger(db: Queryable, kind: string, detail: Record<string, unknown>, stateVersion: number, shiftId: number): Promise<void> {
  await db.query(`INSERT INTO replan_triggers (shift_id, kind, detail, state_version) VALUES ($1, $2, $3, $4)`, [shiftId, kind, JSON.stringify(detail), stateVersion])
}

export async function surprise(db: Queryable, kind: string, detail: Record<string, unknown>, actor: string): Promise<number> {
  const version = await bumpState(db, kind, detail, actor)
  const { rows } = await db.query<{ shift_id: number }>(`SELECT shift_id FROM yard_state WHERE yard_id = $1`, [YARD_ID])
  await addTrigger(db, kind, detail, version, rows[0].shift_id)
  return version
}

export interface AlertInput {
  dedupKey: string
  kind: string
  severity: 'critical' | 'warning' | 'info'
  message: string
  carId?: string | null
  outboundId?: string | null
  moveKey?: string | null
}

export async function raiseAlert(db: Queryable, a: AlertInput): Promise<void> {
  await db.query(
    `INSERT INTO alerts (dedup_key, shift_id, kind, severity, message, car_id, outbound_id, move_key, sim_at)
     SELECT $1, shift_id, $2, $3, $4, $5, $6, $7, sim_now FROM yard_state WHERE yard_id = $8
     ON CONFLICT (dedup_key) DO UPDATE SET message = EXCLUDED.message, status = CASE WHEN alerts.status = 'resolved' THEN 'open' ELSE alerts.status END, resolved_at = NULL`,
    [a.dedupKey, a.kind, a.severity, a.message, a.carId ?? null, a.outboundId ?? null, a.moveKey ?? null, YARD_ID],
  )
}

export async function resolveAlert(db: Queryable, dedupKey: string): Promise<void> {
  await db.query(`UPDATE alerts SET status = 'resolved', resolved_at = now() WHERE dedup_key = $1 AND status <> 'resolved'`, [dedupKey])
}
