/**
 * The job state machine. Every function here takes the run's row lock first, then
 * job rows, then a log stream: one lock order everywhere, so nothing deadlocks.
 *
 * The run lock is also the answer to the fan-in race. Two prerequisites finishing
 * at the same instant would, under READ COMMITTED, each see the other as still
 * running and neither would enqueue the dependent. Serializing completions per run
 * means the second one sees the first one's success. The contention is one run's
 * own jobs, a few transactions per second at most.
 * @module scheduling/engine
 */
import type pg from 'pg'
import { config } from '../shared/config.js'
import { pool, withTransaction } from '../shared/db.js'
import { HttpError, notFound } from '../shared/errors.js'
import { logger } from '../shared/logger.js'
import { jobOutcomes, leaseDecisions } from '../shared/metrics.js'
import { closeLogStream, publishLogTick, type ClosedStream } from '../logs/ingest.js'
import { evaluateEnvironmentGate, type EnvironmentRules } from '../secrets/eligibility.js'
import { computeReadiness, deriveRunStatus, rerunSet, type JobStatus, type RerunMode } from './graph.js'
import { decideCompletion, decideLeaseExpiry, type AttentionDecision, type RunnerConclusion, type StepEvidence } from './decisions.js'
import { leaseLost } from './errors.js'

export interface JobRow {
  id: string
  run_id: string
  repo_id: string
  job_key: string
  name: string
  needs: string[]
  runs_on: string[]
  environment: string | null
  requested_secrets: string[]
  env: Record<string, string>
  steps: { name: string; run: string; idempotent: boolean; timeoutSeconds: number; env: Record<string, string> }[]
  uploads: { name: string; path: string; retentionDays: number }[]
  has_non_idempotent: boolean
  status: JobStatus
  status_reason: string | null
  attempt: number
  auto_requeues: number
  cancel_requested: boolean
  runner_id: string | null
  runner_name: string | null
  fencing_token: number | null
  lease_expires_at: Date | null
  queued_at: Date | null
  started_at: Date | null
  finished_at: Date | null
}

export interface RunRow {
  id: string
  repo_id: string
  status: string
  branch: string
  event_type: string
  is_fork: boolean
  started_at: Date | null
  finished_at: Date | null
  cancel_requested_at: Date | null
  run_attempt: number
  commit_sha: string
  ref: string
  run_number: number
  head_repo: string | null
  pr_number: number | null
}

export async function lockRun(client: pg.PoolClient, runId: string): Promise<RunRow> {
  const { rows } = await client.query<RunRow>('SELECT * FROM workflow_runs WHERE id = $1 FOR NO KEY UPDATE', [runId])
  if (!rows[0]) throw notFound('Run')
  return rows[0]
}

export async function lockJob(client: pg.PoolClient, jobId: string): Promise<JobRow> {
  const { rows } = await client.query<JobRow>('SELECT * FROM jobs WHERE id = $1 FOR NO KEY UPDATE', [jobId])
  if (!rows[0]) throw notFound('Job')
  return rows[0]
}

async function loadJobs(client: pg.PoolClient, runId: string): Promise<JobRow[]> {
  const { rows } = await client.query<JobRow>('SELECT * FROM jobs WHERE run_id = $1 ORDER BY created_at, job_key', [runId])
  return rows
}

export async function runIdOf(db: pg.Pool | pg.PoolClient, jobId: string): Promise<string> {
  const { rows } = await db.query<{ run_id: string }>('SELECT run_id FROM jobs WHERE id = $1', [jobId])
  if (!rows[0]) throw notFound('Job')
  return rows[0].run_id
}

export async function recordTransition(client: pg.PoolClient, job: Pick<JobRow, 'id' | 'run_id' | 'attempt' | 'status'>, to: JobStatus | string, reason: string | null, actor: string | null): Promise<void> {
  await client.query(`INSERT INTO job_transitions (job_id, run_id, attempt, from_status, to_status, reason, actor) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
    job.id,
    job.run_id,
    job.attempt,
    job.status,
    to,
    reason,
    actor,
  ])
}

async function loadEnvironment(client: pg.PoolClient, repoId: string, name: string): Promise<EnvironmentRules | null> {
  const { rows } = await client.query<{ name: string; required_approval: boolean; allowed_branches: string[] }>(
    'SELECT name, required_approval, allowed_branches FROM environments WHERE repo_id = $1 AND name = $2',
    [repoId, name],
  )
  return rows[0] ? { name: rows[0].name, requiredApproval: rows[0].required_approval, allowedBranches: rows[0].allowed_branches } : null
}

export async function loadGate(client: pg.PoolClient, run: Pick<RunRow, 'is_fork' | 'branch' | 'event_type' | 'repo_id'>, job: Pick<JobRow, 'id' | 'attempt' | 'environment'>) {
  const env = job.environment ? await loadEnvironment(client, run.repo_id, job.environment) : null
  const approval = job.environment
    ? ((await client.query<{ decision: 'approved' | 'rejected' }>('SELECT decision FROM environment_approvals WHERE job_id = $1 AND attempt = $2', [job.id, job.attempt])).rows[0]?.decision ?? null)
    : null
  return evaluateEnvironmentGate({ isFork: run.is_fork, branch: run.branch, eventType: run.event_type }, job.environment, env, approval)
}

/** A job whose prerequisites are met goes through its environment gate: into the queue, to a person, or out. */
async function enterGate(client: pg.PoolClient, run: RunRow, job: JobRow, actor: string | null): Promise<void> {
  const gate = await loadGate(client, run, job)
  if (gate.action === 'allow') {
    const { rowCount } = await client.query(`UPDATE jobs SET status = 'queued', status_reason = NULL, queued_at = clock_timestamp() WHERE id = $1 AND status IN ('blocked', 'waiting')`, [job.id])
    if (rowCount) {
      await client.query(`UPDATE job_attempts SET status = 'queued', status_reason = NULL, queued_at = clock_timestamp() WHERE job_id = $1 AND attempt = $2`, [job.id, job.attempt])
      await recordTransition(client, job, 'queued', null, actor)
    }
  } else if (gate.action === 'wait') {
    const { rowCount } = await client.query(`UPDATE jobs SET status = 'waiting', status_reason = $2 WHERE id = $1 AND status = 'blocked'`, [job.id, gate.reason])
    if (rowCount) {
      await client.query(`UPDATE job_attempts SET status = 'waiting', status_reason = $3 WHERE job_id = $1 AND attempt = $2`, [job.id, job.attempt, gate.reason])
      await recordTransition(client, job, 'waiting', gate.reason, actor)
    }
  } else {
    await finishWithoutRunning(client, job, 'failure', gate.reason, actor)
  }
}

export async function finishWithoutRunning(client: pg.PoolClient, job: JobRow, status: 'failure' | 'skipped' | 'cancelled', reason: string, actor: string | null): Promise<void> {
  const { rowCount } = await client.query(`UPDATE jobs SET status = $2, status_reason = $3, finished_at = now() WHERE id = $1 AND status IN ('blocked', 'queued', 'waiting')`, [job.id, status, reason])
  if (!rowCount) return
  await client.query(`UPDATE job_attempts SET status = $3, status_reason = $4, finished_at = now(), closed_by = 'scheduler' WHERE job_id = $1 AND attempt = $2`, [job.id, job.attempt, status, reason])
  await recordTransition(client, job, status, reason, actor)
}

/**
 * Applies readiness until nothing changes, then derives the run's status. Called in
 * the same transaction as whatever changed a job, under the run lock. That is how
 * dependents learn their prerequisites finished: not by polling or a message, but
 * because the completing transaction decided it, atomically with the completion.
 */
export async function advanceRun(client: pg.PoolClient, run: RunRow, actor: string | null): Promise<void> {
  for (;;) {
    const jobs = await loadJobs(client, run.id)
    const byKey = new Map(jobs.map((j) => [j.job_key, j]))
    const { ready, skip } = computeReadiness(jobs.map((j) => ({ key: j.job_key, name: j.name, status: j.status, needs: j.needs })))
    if (ready.length === 0 && skip.length === 0) {
      const everStarted = run.started_at !== null || jobs.some((j) => j.started_at !== null)
      const status = deriveRunStatus(jobs, everStarted)
      const terminal = status === 'success' || status === 'failure' || status === 'cancelled'
      await client.query(`UPDATE workflow_runs SET status = $2, finished_at = CASE WHEN $3 THEN COALESCE(finished_at, now()) ELSE NULL END WHERE id = $1`, [run.id, status, terminal])
      run.status = status
      return
    }
    for (const s of skip) await finishWithoutRunning(client, byKey.get(s.key) as JobRow, 'skipped', s.reason, actor)
    for (const key of ready) await enterGate(client, run, byKey.get(key) as JobRow, actor)
  }
}

export async function loadStepEvidence(client: pg.PoolClient, jobId: string, attempt: number): Promise<StepEvidence[]> {
  const { rows } = await client.query<{ name: string; idempotent: boolean; status: StepEvidence['status']; started_at: Date | null }>(
    'SELECT name, idempotent, status, started_at FROM step_executions WHERE job_id = $1 AND attempt = $2 ORDER BY step_index',
    [jobId, attempt],
  )
  return rows.map((r) => ({ name: r.name, idempotent: r.idempotent, status: r.status, startedAt: r.started_at }))
}

const CLEAR_LEASE = 'runner_id = NULL, runner_name = NULL, fencing_token = NULL, lease_expires_at = NULL, last_heartbeat_at = NULL'

export interface CompleteInput {
  conclusion: RunnerConclusion
  reason?: string | null
}

export interface CompleteResult {
  status: string
  replay: boolean
}

/**
 * A runner's final report. Fenced: only the current lease holder's write counts. A
 * retry after a lost response finds its own finished attempt and gets the same
 * answer. A stale runner's report is rejected as truth, but kept as evidence: if
 * its deploy did land, the person resolving `needs_attention` should know.
 */
export async function completeAttempt(jobId: string, attempt: number, token: number, input: CompleteInput): Promise<CompleteResult> {
  let closed: ClosedStream | null = null
  const result = await withTransaction(async (client) => {
    const run = await lockRun(client, await runIdOf(client, jobId))
    const job = await lockJob(client, jobId)
    if (job.status !== 'running' || job.fencing_token !== token || job.attempt !== attempt) {
      const previous = await client.query<{ status: string; closed_by: string | null }>('SELECT status, closed_by FROM job_attempts WHERE job_id = $1 AND attempt = $2 AND fencing_token = $3', [jobId, attempt, token])
      const own = previous.rows[0]
      if (own && own.closed_by === 'runner') return { status: own.status, replay: true }
      if (own) {
        await client.query(`UPDATE job_attempts SET late_report = $3 WHERE job_id = $1 AND attempt = $2`, [jobId, attempt, JSON.stringify({ conclusion: input.conclusion, reason: input.reason ?? null, at: new Date().toISOString() })])
      }
      return { lost: true as const }
    }

    const steps = await loadStepEvidence(client, jobId, attempt)
    const decision = decideCompletion(input.conclusion, steps, input.reason ?? null)
    await client.query(
      `UPDATE step_executions SET status = CASE WHEN status = 'pending' THEN 'skipped' WHEN status = 'running' THEN 'unknown' ELSE status END, finished_at = COALESCE(finished_at, CASE WHEN status = 'running' THEN now() END)
        WHERE job_id = $1 AND attempt = $2`,
      [jobId, attempt],
    )
    await client.query(`UPDATE jobs SET status = $2, status_reason = $3, finished_at = now(), ${CLEAR_LEASE}, cancel_requested = false WHERE id = $1`, [jobId, decision.status, decision.reason])
    await client.query(`UPDATE job_attempts SET status = $3, status_reason = $4, finished_at = now(), closed_by = 'runner' WHERE job_id = $1 AND attempt = $2`, [jobId, attempt, decision.status, decision.reason])
    await recordTransition(client, job, decision.status, decision.reason, job.runner_name)
    closed = await closeLogStream(client, jobId, attempt, decision.status === 'needs_attention' ? [`[platform] ${decision.reason}`] : [])
    await advanceRun(client, run, job.runner_name)
    jobOutcomes.inc({ outcome: decision.status })
    return { status: decision.status as string, replay: false }
  })
  if ('lost' in result) throw leaseLost('complete')
  if (closed) publishLogTick(closed)
  return result
}

/**
 * A lease ran out. Takes the job row lock before reading the steps: `startStep`
 * holds the same lock while it writes its intent, so a step either is visible here
 * or is rejected there. There is no window where a step starts and the decision
 * misses it. Returns null when the job renewed in the meantime.
 */
export async function expireLease(jobId: string): Promise<string | null> {
  let closed: ClosedStream | null = null
  const result = await withTransaction(async (client) => {
    const run = await lockRun(client, await runIdOf(client, jobId))
    const job = await lockJob(client, jobId)
    const fresh = await client.query<{ expired: boolean }>('SELECT lease_expires_at <= now() AS expired FROM jobs WHERE id = $1', [jobId])
    if (job.status !== 'running' || !fresh.rows[0]?.expired) return null

    const steps = await loadStepEvidence(client, jobId, job.attempt)
    const decision = decideLeaseExpiry(steps, job.auto_requeues, config.lease.maxAutoRequeues, job.runner_name)
    leaseDecisions.inc({ decision: decision.action })
    await client.query(
      `UPDATE step_executions SET status = CASE WHEN status = 'running' THEN 'unknown' WHEN status = 'pending' THEN 'skipped' ELSE status END, finished_at = CASE WHEN status = 'running' THEN now() ELSE finished_at END
        WHERE job_id = $1 AND attempt = $2`,
      [jobId, job.attempt],
    )
    closed = await closeLogStream(client, jobId, job.attempt, [`[platform] ${decision.reason}`])

    if (decision.action === 'needs_attention') {
      await client.query(`UPDATE jobs SET status = 'needs_attention', status_reason = $2, finished_at = now(), ${CLEAR_LEASE} WHERE id = $1`, [jobId, decision.reason])
      await client.query(`UPDATE job_attempts SET status = 'needs_attention', status_reason = $3, finished_at = now(), closed_by = 'sweeper' WHERE job_id = $1 AND attempt = $2`, [jobId, job.attempt, decision.reason])
      await recordTransition(client, job, 'needs_attention', decision.reason, 'lease-sweeper')
    } else if (decision.action === 'fail' || job.cancel_requested) {
      const status = job.cancel_requested ? 'cancelled' : 'failure'
      const reason = job.cancel_requested ? 'Cancelled; the runner was already gone' : decision.reason
      await client.query(`UPDATE jobs SET status = $2, status_reason = $3, finished_at = now(), ${CLEAR_LEASE}, cancel_requested = false WHERE id = $1`, [jobId, status, reason])
      await client.query(`UPDATE job_attempts SET status = $3, status_reason = $4, finished_at = now(), closed_by = 'sweeper' WHERE job_id = $1 AND attempt = $2`, [jobId, job.attempt, status, reason])
      await recordTransition(client, job, status, reason, 'lease-sweeper')
    } else {
      await client.query(`UPDATE job_attempts SET status = 'lease_expired', status_reason = $3, finished_at = now(), closed_by = 'sweeper' WHERE job_id = $1 AND attempt = $2`, [jobId, job.attempt, decision.reason])
      await recordTransition(client, job, 'lease_expired', decision.reason, 'lease-sweeper')
      await resetJob(client, run, job, 'lease_expired', 'lease-sweeper', false)
      // An automatic retry is the same intent as the attempt it replaces, so its approval carries over.
      await client.query(
        `INSERT INTO environment_approvals (job_id, attempt, decision, decided_by, comment)
         SELECT job_id, $2, decision, decided_by, 'Carried over from the attempt that lost its runner' FROM environment_approvals WHERE job_id = $1 AND attempt = $3 ON CONFLICT DO NOTHING`,
        [jobId, job.attempt + 1, job.attempt],
      )
      await client.query('UPDATE jobs SET auto_requeues = auto_requeues + 1 WHERE id = $1', [jobId])
    }
    await advanceRun(client, run, 'lease-sweeper')
    return decision.action
  })
  if (closed) publishLogTick(closed)
  return result
}

/** Sweeps every expired lease using the database clock. One job's failure doesn't stop the rest. */
export async function sweepExpiredLeases(limit = 100): Promise<{ jobId: string; decision: string }[]> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM jobs WHERE status = 'running' AND lease_expires_at <= now() ORDER BY lease_expires_at LIMIT $1`, [limit])
  const out: { jobId: string; decision: string }[] = []
  for (const { id } of rows) {
    try {
      const decision = await expireLease(id)
      if (decision) out.push({ jobId: id, decision })
    } catch (err) {
      logger.error({ err, jobId: id }, 'lease expiry failed; will retry on the next sweep')
    }
  }
  return out
}

/** Starts a new attempt of a job in place: a new attempts row, same pinned definition. */
async function resetJob(client: pg.PoolClient, run: RunRow, job: JobRow, trigger: string, actor: string | null, confirmed: boolean): Promise<void> {
  const attempt = job.attempt + 1
  await client.query(
    `UPDATE jobs SET status = 'blocked', status_reason = NULL, attempt = $2, cancel_requested = false, ${CLEAR_LEASE}, queued_at = NULL, started_at = NULL, finished_at = NULL WHERE id = $1`,
    [job.id, attempt],
  )
  await client.query(`INSERT INTO job_attempts (job_id, attempt, run_id, run_attempt, trigger, triggered_by, confirmed_non_idempotent, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'blocked')`, [
    job.id,
    attempt,
    run.id,
    run.run_attempt,
    trigger,
    actor,
    confirmed,
  ])
  await recordTransition(client, { ...job, attempt }, 'blocked', `New attempt (${trigger})`, actor)
}

export interface RerunResult {
  runAttempt: number
  jobs: { key: string; attempt: number; status: string }[]
}

export interface RerunRequest {
  runId: string
  mode: RerunMode
  jobKey?: string
  actor: string
  confirmNonIdempotent: boolean
}

/**
 * Re-runs create new attempts within the same run, against the same pinned commit
 * and workflow: the job rows carry the definition, and nothing here reads Git. A
 * job with a non-idempotent step needs explicit confirmation, whichever button got here.
 */
export async function rerun(req: RerunRequest): Promise<RerunResult> {
  return withTransaction(async (client) => {
    const run = await lockRun(client, req.runId)
    if (run.status === 'invalid') throw new HttpError(409, 'RUN_INVALID', 'This run has no jobs: its workflow file was rejected')
    const jobs = await loadJobs(client, run.id)
    if (jobs.some((j) => ['queued', 'running', 'waiting'].includes(j.status))) {
      throw new HttpError(409, 'RUN_NOT_FINISHED', 'Jobs of this run are still active. Wait for them to finish, or cancel the run.')
    }
    if (req.mode === 'job' && !jobs.some((j) => j.job_key === req.jobKey)) throw notFound('Job')
    const keys = rerunSet(jobs.map((j) => ({ key: j.job_key, status: j.status, needs: j.needs })), req.mode, req.jobKey)
    if (keys.length === 0) throw new HttpError(409, 'NOTHING_TO_RERUN', 'There are no failed jobs to re-run')
    const reset = jobs.filter((j) => keys.includes(j.job_key))

    const unresolved = reset.filter((j) => j.status === 'needs_attention')
    if (unresolved.length > 0) {
      throw new HttpError(409, 'ATTENTION_UNRESOLVED', `Resolve ${unresolved.map((j) => `"${j.name}"`).join(', ')} first: its outcome is unknown, and a person has to say what happened`, { jobs: unresolved.map((j) => j.job_key) })
    }
    const unsafe = reset.filter((j) => j.has_non_idempotent)
    if (unsafe.length > 0 && !req.confirmNonIdempotent) {
      throw new HttpError(409, 'CONFIRM_REQUIRED', 'This re-run would execute non-idempotent steps again. Confirm to proceed.', {
        jobs: unsafe.map((j) => ({ key: j.job_key, name: j.name, steps: j.steps.filter((s) => !s.idempotent).map((s) => s.name) })),
      })
    }

    const { rows } = await client.query<{ run_attempt: number }>(`UPDATE workflow_runs SET run_attempt = run_attempt + 1, status = 'queued', finished_at = NULL, cancel_requested_at = NULL, cancelled_by = NULL WHERE id = $1 RETURNING run_attempt`, [run.id])
    run.run_attempt = rows[0].run_attempt
    const trigger = `rerun_${req.mode}`
    const roots = req.mode === 'job' ? [req.jobKey] : keys
    for (const job of reset) {
      await resetJob(client, run, job, roots.includes(job.job_key) ? trigger : 'rerun_dependent', req.actor, job.has_non_idempotent && req.confirmNonIdempotent)
    }
    await advanceRun(client, run, req.actor)
    const after = await loadJobs(client, run.id)
    return { runAttempt: run.run_attempt, jobs: after.filter((j) => keys.includes(j.job_key)).map((j) => ({ key: j.job_key, attempt: j.attempt, status: j.status })) }
  })
}

/**
 * Cancels what hasn't started immediately and flags what has; the runner learns from
 * its next heartbeat and kills the step's process group. A needs_attention job is left
 * alone: cancelling a run doesn't answer the question of whether the deploy landed.
 */
export async function cancelRun(runId: string, actor: string): Promise<{ status: string; signalled: number }> {
  return withTransaction(async (client) => {
    const run = await lockRun(client, runId)
    if (['success', 'failure', 'cancelled', 'invalid'].includes(run.status)) return { status: run.status, signalled: 0 }
    await client.query('UPDATE workflow_runs SET cancel_requested_at = now(), cancelled_by = $2 WHERE id = $1', [runId, actor])
    const jobs = await loadJobs(client, runId)
    let signalled = 0
    for (const job of jobs) {
      if (['blocked', 'queued', 'waiting'].includes(job.status)) {
        await finishWithoutRunning(client, job, 'cancelled', `Cancelled by ${actor}`, actor)
      } else if (job.status === 'running') {
        await client.query('UPDATE jobs SET cancel_requested = true WHERE id = $1', [job.id])
        await recordTransition(client, job, 'running', `Cancel requested by ${actor}`, actor)
        signalled++
      }
    }
    await advanceRun(client, run, actor)
    return { status: run.status, signalled }
  })
}

/** Records a maintainer's decision for this attempt; approval re-enters the gate, rejection fails the job and skips downstream. */
export async function decideApproval(jobId: string, decision: 'approved' | 'rejected', actor: string, comment: string | null): Promise<{ status: string }> {
  return withTransaction(async (client) => {
    const run = await lockRun(client, await runIdOf(client, jobId))
    const job = await lockJob(client, jobId)
    if (job.status !== 'waiting') throw new HttpError(409, 'NOT_WAITING', 'This job is not waiting for an approval')
    await client.query(`INSERT INTO environment_approvals (job_id, attempt, decision, decided_by, comment) VALUES ($1, $2, $3, $4, $5)`, [jobId, job.attempt, decision, actor, comment])
    await enterGate(client, run, job, actor)
    await advanceRun(client, run, actor)
    const { rows } = await client.query<{ status: string }>('SELECT status FROM jobs WHERE id = $1', [jobId])
    return { status: rows[0].status }
  })
}

export interface ResolveRequest {
  jobId: string
  decision: AttentionDecision
  note: string | null
  actor: string
  /** Retrying executes the non-idempotent step again: the caller has to say so explicitly. */
  confirmRetry: boolean
}

/**
 * The human half of needs_attention. Someone looked at the deployment target and
 * says what happened: it succeeded (dependents continue), it failed (dependents are
 * skipped), or it is safe to run again (a new attempt).
 */
export async function resolveAttention(req: ResolveRequest): Promise<{ status: string; attempt: number }> {
  return withTransaction(async (client) => {
    const run = await lockRun(client, await runIdOf(client, req.jobId))
    const job = await lockJob(client, req.jobId)
    if (job.status !== 'needs_attention') throw new HttpError(409, 'NOT_NEEDS_ATTENTION', 'This job is not waiting for a decision')
    await client.query(`UPDATE job_attempts SET resolved_decision = $3, resolved_note = $4, resolved_by = $5, resolved_at = now() WHERE job_id = $1 AND attempt = $2`, [req.jobId, job.attempt, req.decision, req.note, req.actor])
    const note = req.note ? `: ${req.note}` : ''
    if (req.decision === 'retry') {
      if (!req.confirmRetry) throw new HttpError(409, 'CONFIRM_REQUIRED', 'Retrying executes the non-idempotent step again. Confirm to proceed.')
      await resetJob(client, run, job, 'attention_retry', req.actor, true)
      await client.query(`UPDATE workflow_runs SET run_attempt = run_attempt + 1 WHERE id = $1`, [run.id])
      // The new attempt needs the same approval again: a person retried it, so a person approves it.
    } else {
      const status = req.decision === 'succeeded' ? 'success' : 'failure'
      const reason = `Marked ${req.decision} by ${req.actor}${note}`
      await client.query(`UPDATE jobs SET status = $2, status_reason = $3, finished_at = now() WHERE id = $1`, [req.jobId, status, reason])
      await client.query(`UPDATE job_attempts SET status = $3, status_reason = $4, closed_by = 'human' WHERE job_id = $1 AND attempt = $2`, [req.jobId, job.attempt, status, reason])
      await recordTransition(client, job, status, reason, req.actor)
    }
    await advanceRun(client, run, req.actor)
    const { rows } = await client.query<{ status: string; attempt: number }>('SELECT status, attempt FROM jobs WHERE id = $1', [req.jobId])
    return rows[0]
  })
}
