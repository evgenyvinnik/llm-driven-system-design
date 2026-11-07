/**
 * Processing jobs: one row per (document version, stage), or per (document,
 * stage) for document-level work. The row holds status, attempts, a lease and
 * the next run time; RabbitMQ tickets only point at it.
 *
 * - enqueue: INSERT ... ON CONFLICT (job_key) DO NOTHING, inside the caller's
 *   transaction, so a stage that commits twice can't create a second job.
 * - claim: a conditional UPDATE that takes a pending, due job, or takes over
 *   a running one whose lease expired (or whose ticket was redelivered, which
 *   RabbitMQ only does after the holder's channel died). Every claim counts as
 *   an attempt, so a document that kills the worker every time is poisoned.
 * - complete / fail: fenced by the lease token. A worker that lost its lease
 *   (it was presumed dead and someone took over) can't overwrite the result.
 *
 * Every time written here (leases, retries) uses the database clock.
 * @module pipeline/jobs
 */
import { randomBytes } from 'node:crypto'
import type pg from 'pg'
import { config } from '../shared/config.js'
import { pool, withTransaction, type Queryable } from '../shared/db.js'
import { newId } from '../shared/ids.js'

export type Stage = 'extract' | 'chunk' | 'embed' | 'index' | 'retire' | 'sync_acl' | 'purge'
export const PIPELINE_STAGES: Stage[] = ['extract', 'chunk', 'embed', 'index']
export type JobStatus = 'pending' | 'running' | 'succeeded' | 'poisoned' | 'cancelled'

export interface JobRow {
  id: string
  job_key: string
  document_id: string
  version_id: string | null
  org_id: string
  stage: Stage
  status: JobStatus
  attempts: number
  max_attempts: number
  generation: number
  lease_token: string | null
  lease_owner: string | null
  progress: Record<string, unknown>
  last_error: string | null
}

export interface ClaimedJob extends JobRow {
  lease_token: string
  attemptId: string
  /** The previous holder, when this claim took over a running job. */
  tookOverFrom: string | null
}

export function jobKey(stage: Stage, documentId: string, versionId: string | null): string {
  return versionId && stage !== 'sync_acl' && stage !== 'purge' ? `${versionId}:${stage}` : `${documentId}:${stage}`
}

export function maxAttemptsFor(stage: Stage): number {
  return stage === 'purge' ? config.pipeline.purgeMaxAttempts : config.pipeline.maxAttempts
}

/** Equal-jitter exponential backoff: half fixed, half random, capped. */
export function backoffMs(attempt: number, base = config.pipeline.backoffBaseMs, cap = config.pipeline.backoffCapMs, rnd = Math.random): number {
  const ceiling = Math.min(cap, base * 2 ** Math.max(0, attempt - 1))
  return Math.round(ceiling / 2 + (rnd() * ceiling) / 2)
}

export interface EnqueueSpec {
  documentId: string
  versionId: string | null
  orgId: string
  stage: Stage
  delayMs?: number
  /** Re-arm an existing job (sync_acl): a later change must always be applied, even if a sync is running. */
  rearm?: boolean
}

/** Creates the job if it doesn't exist yet. Returns its id when a ticket should be published now. */
export async function enqueueJob(db: Queryable, spec: EnqueueSpec): Promise<string | null> {
  const key = jobKey(spec.stage, spec.documentId, spec.versionId)
  const delay = spec.delayMs ?? 0
  if (spec.rearm) {
    const { rows } = await db.query<{ id: string; status: JobStatus }>(
      `INSERT INTO processing_jobs (id, job_key, document_id, version_id, org_id, stage, max_attempts, next_run_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8 || ' milliseconds')::interval)
       ON CONFLICT (job_key) DO UPDATE SET
         generation = processing_jobs.generation + 1,
         status = CASE WHEN processing_jobs.status = 'running' THEN 'running' ELSE 'pending' END,
         attempts = CASE WHEN processing_jobs.status = 'running' THEN processing_jobs.attempts ELSE 0 END,
         next_run_at = now() + ($8 || ' milliseconds')::interval,
         dispatched_at = CASE WHEN processing_jobs.status = 'running' THEN processing_jobs.dispatched_at ELSE NULL END,
         last_error = NULL,
         updated_at = now()
       RETURNING id, status`,
      [newId.job(), key, spec.documentId, spec.versionId, spec.orgId, spec.stage, maxAttemptsFor(spec.stage), String(delay)],
    )
    return rows[0]?.status === 'pending' && delay === 0 ? rows[0].id : null
  }
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO processing_jobs (id, job_key, document_id, version_id, org_id, stage, max_attempts, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8 || ' milliseconds')::interval)
     ON CONFLICT (job_key) DO NOTHING
     RETURNING id`,
    [newId.job(), key, spec.documentId, spec.versionId, spec.orgId, spec.stage, maxAttemptsFor(spec.stage), String(delay)],
  )
  return rows[0] && delay === 0 ? rows[0].id : null
}

export async function markDispatched(jobIds: string[], db: Queryable = pool): Promise<void> {
  if (jobIds.length === 0) return
  await db.query(`UPDATE processing_jobs SET dispatched_at = now() WHERE id = ANY($1) AND status = 'pending'`, [jobIds])
}

/**
 * Claims a job for this worker. Returns null when the ticket is stale (job
 * done, cancelled, not yet due, or held by a live lease).
 */
export async function claimJob(jobId: string, workerId: string, redelivered: boolean): Promise<ClaimedJob | null> {
  const token = randomBytes(12).toString('base64url')
  return withTransaction(async (client) => {
    const { rows } = await client.query<JobRow & { prev_token: string | null; prev_owner: string | null; prev_status: JobStatus }>(
      `WITH prev AS (
         SELECT id, status, lease_token, lease_owner FROM processing_jobs WHERE id = $1 FOR UPDATE
       )
       UPDATE processing_jobs j SET
         status = 'running',
         attempts = j.attempts + 1,
         lease_owner = $2,
         lease_token = $3,
         lease_expires_at = now() + ($4 || ' milliseconds')::interval,
         started_at = COALESCE(j.started_at, now()),
         updated_at = now()
       FROM prev
       WHERE j.id = prev.id AND (
         (j.status = 'pending' AND j.next_run_at <= now() + interval '250 milliseconds')
         OR (j.status = 'running' AND (j.lease_expires_at < now() OR $5::boolean))
       )
       RETURNING j.*, prev.lease_token AS prev_token, prev.lease_owner AS prev_owner, prev.status AS prev_status`,
      [jobId, workerId, token, String(config.pipeline.leaseMs), redelivered],
    )
    const row = rows[0]
    if (!row) return null
    let tookOverFrom: string | null = null
    if (row.prev_status === 'running' && row.prev_token) {
      tookOverFrom = row.prev_owner
      await client.query(
        `UPDATE job_attempts SET outcome = 'lost', finished_at = now(), error = $3
          WHERE job_id = $1 AND lease_token = $2 AND outcome IS NULL`,
        [jobId, row.prev_token, `worker ${row.prev_owner ?? '?'} stopped before finishing (lease taken over by ${workerId})`],
      )
    }
    const attemptId = newId.attempt()
    await client.query(`INSERT INTO job_attempts (id, job_id, attempt_no, worker_id, lease_token) VALUES ($1, $2, $3, $4, $5)`, [
      attemptId,
      jobId,
      row.attempts,
      workerId,
      token,
    ])
    return { ...row, lease_token: token, attemptId, tookOverFrom }
  })
}

/** Extends the lease. False means the lease was lost (taken over); the caller must stop. */
export async function heartbeat(job: ClaimedJob): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE processing_jobs SET lease_expires_at = now() + ($3 || ' milliseconds')::interval, updated_at = now()
      WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
    [job.id, job.lease_token, String(config.pipeline.leaseMs)],
  )
  return (rowCount ?? 0) > 0
}

export async function setProgress(job: ClaimedJob, progress: Record<string, unknown>): Promise<void> {
  await pool.query(`UPDATE processing_jobs SET progress = $3, updated_at = now() WHERE id = $1 AND lease_token = $2`, [job.id, job.lease_token, progress])
}

/**
 * Marks the job succeeded (or pending again, if it was re-armed while
 * running). Runs in the caller's transaction so the stage's final writes, the
 * next stage's job and the completion commit together. False = superseded.
 */
export async function completeJob(client: pg.PoolClient, job: ClaimedJob, detail: Record<string, unknown> = {}): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE processing_jobs SET
       status = CASE WHEN generation = $3 THEN 'succeeded' ELSE 'pending' END,
       attempts = CASE WHEN generation = $3 THEN attempts ELSE 0 END,
       next_run_at = now(), dispatched_at = NULL,
       finished_at = CASE WHEN generation = $3 THEN now() ELSE NULL END,
       lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = now()
     WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
    [job.id, job.lease_token, job.generation],
  )
  await client.query(`UPDATE job_attempts SET outcome = $2, finished_at = now(), detail = $3 WHERE id = $1`, [
    job.attemptId,
    (rowCount ?? 0) > 0 ? 'succeeded' : 'superseded',
    detail,
  ])
  return (rowCount ?? 0) > 0
}

/** Puts a job back to pending without counting the attempt (e.g. sync paused, purge waiting for a running stage). */
export async function deferJob(job: ClaimedJob, delayMs: number, reason: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE processing_jobs SET status = 'pending', attempts = GREATEST(0, attempts - 1), next_run_at = now() + ($3 || ' milliseconds')::interval,
         dispatched_at = NULL, lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, last_error = $4, updated_at = now()
       WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
      [job.id, job.lease_token, String(delayMs), reason],
    )
    await client.query(`DELETE FROM job_attempts WHERE id = $1`, [job.attemptId])
  })
}

export type FailOutcome = 'retry' | 'poisoned' | 'superseded'

/**
 * Records a failed attempt: retry later (backoff on the DB clock), or poison
 * when the error is permanent or attempts are used up. `onPoison` runs in the
 * same transaction (mark the version / document failed).
 */
export async function failJob(
  job: ClaimedJob,
  error: string,
  permanent: boolean,
  onPoison?: (client: pg.PoolClient) => Promise<void>,
): Promise<FailOutcome> {
  return withTransaction(async (client) => {
    const poison = permanent || job.attempts >= job.max_attempts
    const delay = backoffMs(job.attempts)
    const { rowCount } = await client.query(
      `UPDATE processing_jobs SET
         status = $3,
         next_run_at = CASE WHEN $3 = 'pending' THEN now() + ($4 || ' milliseconds')::interval ELSE next_run_at END,
         finished_at = CASE WHEN $3 = 'poisoned' THEN now() ELSE NULL END,
         dispatched_at = NULL, lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
         last_error = $5, updated_at = now()
       WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
      [job.id, job.lease_token, poison ? 'poisoned' : 'pending', String(delay), error],
    )
    const outcome: FailOutcome = (rowCount ?? 0) === 0 ? 'superseded' : poison ? 'poisoned' : 'retry'
    await client.query(`UPDATE job_attempts SET outcome = $2, finished_at = now(), error = $3, detail = $4 WHERE id = $1`, [
      job.attemptId,
      outcome === 'superseded' ? 'superseded' : poison ? (permanent ? 'failed' : 'poisoned') : 'retry',
      error,
      outcome === 'retry' ? { retryInMs: delay } : {},
    ])
    if (outcome === 'poisoned' && onPoison) await onPoison(client)
    return outcome
  })
}

/** Cancels a job that found its document tombstoned. */
export async function cancelJob(client: pg.PoolClient, job: ClaimedJob, reason: string): Promise<void> {
  await client.query(
    `UPDATE processing_jobs SET status = 'cancelled', finished_at = now(), lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
       last_error = $3, updated_at = now() WHERE id = $1 AND lease_token = $2`,
    [job.id, job.lease_token, reason],
  )
  await client.query(`UPDATE job_attempts SET outcome = 'succeeded', finished_at = now(), detail = $2 WHERE id = $1`, [job.attemptId, { cancelled: reason }])
}

/** Operator / owner retry of a poisoned job: attempts reset, due now. Returns the job id to publish. */
export async function retryPoisoned(client: pg.PoolClient, jobId: string): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `UPDATE processing_jobs SET status = 'pending', attempts = 0, next_run_at = now(), dispatched_at = NULL, finished_at = NULL,
       last_error = NULL, updated_at = now()
     WHERE id = $1 AND status = 'poisoned' RETURNING id`,
    [jobId],
  )
  return rows[0]?.id ?? null
}
