/**
 * The solve queue in PostgreSQL. A solve is a row before anything computes it.
 * Claiming uses SKIP LOCKED and a lease measured on the database clock, so a
 * worker killed mid-solve leaves a row someone else reclaims when the lease runs
 * out. Solves have no side effects until one commit at the end, fenced by the
 * lease token, so a stalled worker can't overwrite its replacement's result, and
 * there's never a half-written plan.
 * @module worker/jobs
 */
import { randomBytes } from 'node:crypto'
import type { Queryable } from '../shared/db.js'
import { pool } from '../shared/db.js'
import { config } from '../shared/config.js'

export interface EnqueueArgs {
  shiftId: number
  lane?: 'plan' | 'analysis'
  purpose: 'initial' | 'replan' | 'manual' | 'compare' | 'replay'
  algorithm: string
  reason: string
  timeLimitMs: number
  iterationLimit: number
  seed: number
  params?: Record<string, unknown>
  triggerCount?: number
}

export async function enqueueSolve(db: Queryable, a: EnqueueArgs): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO solve_jobs (shift_id, lane, purpose, algorithm, reason, time_limit_ms, iteration_limit, seed, params, trigger_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [a.shiftId, a.lane ?? 'plan', a.purpose, a.algorithm, a.reason, a.timeLimitMs, a.iterationLimit, a.seed, JSON.stringify(a.params ?? {}), a.triggerCount ?? 0],
  )
  return rows[0].id
}

export interface ClaimedJob {
  id: string
  shiftId: number
  lane: 'plan' | 'analysis'
  purpose: EnqueueArgs['purpose']
  algorithm: string
  reason: string
  timeLimitMs: number
  iterationLimit: number
  seed: number
  params: Record<string, unknown>
  attempts: number
  leaseToken: string
  reclaimed: boolean
}

export async function claimJob(lane: 'plan' | 'analysis', workerId: string): Promise<ClaimedJob | null> {
  const token = randomBytes(12).toString('hex')
  const { rows } = await pool.query(
    `WITH next AS (
       SELECT id, status AS prior_status FROM solve_jobs
        WHERE lane = $1 AND (status = 'queued' OR (status = 'running' AND lease_expires_at <= now()))
        ORDER BY queued_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE solve_jobs j
        SET status = 'running', attempts = j.attempts + 1, lease_owner = $2, lease_token = $3,
            lease_expires_at = now() + make_interval(secs => $4::float8 / 1000), started_at = COALESCE(j.started_at, now())
       FROM next
      WHERE j.id = next.id
     RETURNING j.*, next.prior_status`,
    [lane, workerId, token, config.planner.leaseMs],
  )
  const r = rows[0]
  if (!r) return null
  return {
    id: r.id,
    shiftId: r.shift_id,
    lane: r.lane,
    purpose: r.purpose,
    algorithm: r.algorithm,
    reason: r.reason,
    timeLimitMs: r.time_limit_ms,
    iterationLimit: r.iteration_limit,
    seed: r.seed,
    params: r.params ?? {},
    attempts: r.attempts,
    leaseToken: token,
    reclaimed: r.prior_status === 'running',
  }
}

/** Extends the lease. False means somebody else owns the job now: stop, and don't write. */
export async function heartbeat(id: string, token: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE solve_jobs SET lease_expires_at = now() + make_interval(secs => $3::float8 / 1000) WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
    [id, token, config.planner.leaseMs],
  )
  return (rowCount ?? 0) > 0
}

export async function failJob(id: string, token: string, attempts: number, error: string): Promise<'requeued' | 'failed' | 'lost'> {
  const giveUp = attempts >= config.planner.maxAttempts
  const { rowCount } = await pool.query(
    `UPDATE solve_jobs SET status = $3, error = $4, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, finished_at = CASE WHEN $3 = 'failed' THEN now() END
      WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
    [id, token, giveUp ? 'failed' : 'queued', error.slice(0, 2000)],
  )
  if (!rowCount) return 'lost'
  return giveUp ? 'failed' : 'requeued'
}
