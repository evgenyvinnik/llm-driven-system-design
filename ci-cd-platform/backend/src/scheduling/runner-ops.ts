/**
 * The fenced writes a runner makes while it holds a job: renew the lease, announce a
 * step, report a step. Every one is checked against the job's current fencing token,
 * and each lost-lease rejection tells the runner to stop.
 * @module scheduling/runner-ops
 */
import type pg from 'pg'
import { config } from '../shared/config.js'
import { pool, withTransaction } from '../shared/db.js'
import { HttpError, notFound } from '../shared/errors.js'
import { leaseLost } from './errors.js'

export interface Fence {
  jobId: string
  attempt: number
  fencingToken: number
  runnerId: string
}

/** Locks the job row and checks the lease; the lock is what makes a step-start atomic with lease expiry. */
async function lockFenced(client: pg.PoolClient, fence: Fence, operation: string): Promise<{ run_id: string; status: string }> {
  const { rows } = await client.query<{ run_id: string; status: string; fencing_token: number | null; attempt: number; runner_id: string | null }>(
    'SELECT run_id, status, fencing_token, attempt, runner_id FROM jobs WHERE id = $1 FOR NO KEY UPDATE',
    [fence.jobId],
  )
  const job = rows[0]
  if (!job) throw notFound('Job')
  // Fencing tokens are sequential, so holding one proves nothing on its own: the caller has to be its holder too.
  if (job.runner_id !== null && job.runner_id !== fence.runnerId) throw leaseLost(operation)
  if (job.status !== 'running' || job.fencing_token !== fence.fencingToken || job.attempt !== fence.attempt) throw leaseLost(operation)
  return job
}

/** The fence check without a lock, for reads and for writes that are harmless if they land just before expiry. */
export async function assertFence(db: Pick<pg.Pool, 'query'>, fence: Fence, operation: string): Promise<void> {
  const { rows } = await db.query<{ status: string; fencing_token: number | null; attempt: number; runner_id: string | null }>('SELECT status, fencing_token, attempt, runner_id FROM jobs WHERE id = $1', [fence.jobId])
  const job = rows[0]
  if (!job) throw notFound('Job')
  if (job.runner_id !== fence.runnerId || job.status !== 'running' || job.fencing_token !== fence.fencingToken || job.attempt !== fence.attempt) throw leaseLost(operation)
}

/**
 * The write-ahead intent, and the most important write a runner makes: it must commit
 * before the process is spawned. If the runner dies one instruction later, the row says
 * this step may have run. Replaying the call is harmless.
 */
export async function startStep(fence: Fence, stepIndex: number): Promise<{ killRunner: boolean }> {
  return withTransaction(async (client) => {
    const job = await lockFenced(client, fence, 'step_start')
    const { rows } = await client.query<{ name: string }>(
      `UPDATE step_executions SET status = 'running', started_at = COALESCE(started_at, now())
        WHERE job_id = $1 AND attempt = $2 AND step_index = $3 AND status IN ('pending', 'running') RETURNING name`,
      [fence.jobId, fence.attempt, stepIndex],
    )
    if (!rows[0]) throw new HttpError(409, 'STEP_NOT_STARTABLE', 'This step already finished, or does not exist')
    await client.query('UPDATE jobs SET lease_expires_at = now() + make_interval(secs => $2::float8 / 1000), last_heartbeat_at = now() WHERE id = $1', [fence.jobId, config.lease.ms])

    // Fixture panel: "kill the runner when this step starts".
    const armed = await client.query(`UPDATE chaos_arms SET fired_at = now() WHERE run_id = $1 AND step_name = $2 AND fired_at IS NULL RETURNING run_id`, [job.run_id, rows[0].name])
    if (armed.rows.length > 0) await client.query('UPDATE runners SET kill_requested = true WHERE id = $1', [fence.runnerId])
    return { killRunner: armed.rows.length > 0 }
  })
}

export async function finishStep(fence: Fence, stepIndex: number, status: 'success' | 'failure' | 'timed_out' | 'killed', exitCode: number | null): Promise<void> {
  await withTransaction(async (client) => {
    await lockFenced(client, fence, 'step_finish')
    await client.query(`UPDATE step_executions SET status = $4, exit_code = $5, finished_at = now() WHERE job_id = $1 AND attempt = $2 AND step_index = $3 AND status = 'running'`, [
      fence.jobId,
      fence.attempt,
      stepIndex,
      status,
      exitCode,
    ])
  })
}

export interface HeartbeatJob {
  jobId: string
  attempt: number
  fencingToken: number
}

export interface HeartbeatResult {
  die: boolean
  jobs: { jobId: string; ok: boolean; cancel: boolean }[]
}

/**
 * Renews every lease the runner holds, in one call. `ok: false` means the lease is
 * gone: stop the step. `cancel: true` means a person cancelled the run. `die` is the
 * demo's chaos switch: the runner kills itself with SIGKILL, for real.
 */
export async function heartbeat(runnerId: string, jobs: HeartbeatJob[]): Promise<HeartbeatResult> {
  const me = await pool.query<{ kill_requested: boolean }>(`UPDATE runners SET last_seen_at = now(), kill_requested = false WHERE id = $1 RETURNING (SELECT kill_requested FROM runners WHERE id = $1) AS kill_requested`, [runnerId])
  const results: HeartbeatResult['jobs'] = []
  for (const job of jobs) {
    const { rows } = await pool.query<{ cancel_requested: boolean }>(
      `UPDATE jobs SET lease_expires_at = now() + make_interval(secs => $5::float8 / 1000), last_heartbeat_at = now()
        WHERE id = $1 AND attempt = $2 AND fencing_token = $3 AND runner_id = $4 AND status = 'running' RETURNING cancel_requested`,
      [job.jobId, job.attempt, job.fencingToken, runnerId, config.lease.ms],
    )
    results.push({ jobId: job.jobId, ok: rows.length > 0, cancel: rows[0]?.cancel_requested ?? false })
  }
  return { die: me.rows[0]?.kill_requested ?? false, jobs: results }
}
