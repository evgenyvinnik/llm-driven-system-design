/**
 * The claim path: PostgreSQL as the queue. One transaction:
 *
 *   1. Lock one repository with SKIP LOCKED, least recently served first, among those
 *      with a queued job this runner's labels can take and room under their limit.
 *      Round robin between repositories means a burst on one can only ever cost
 *      another repository one turn. Concurrent claimers skip to a different repository.
 *   2. Holding that lock, re-count its running jobs in a fresh statement. Claims per
 *      repository are serialized by the lock, so the limit is exact, not approximate.
 *   3. Take the oldest matching job, lock its run, re-check its environment gate.
 *      The gate is enforced here, not only when the job was queued: the claim is the
 *      last moment before code and credentials leave the control plane.
 *   4. Decide and decrypt the secrets, write the audit row, take the lease.
 *
 * The audit rows commit with the lease, so a release is never missing from the trail.
 * @module scheduling/claim
 */
import type pg from 'pg'
import { config } from '../shared/config.js'
import { decrypt, encrypt } from '../shared/crypto.js'
import { pool } from '../shared/db.js'
import { claims, queueWait, secretReleases, secretsWithheld } from '../shared/metrics.js'
import { decideSecretRelease, type GateDecision, type SecretCandidate } from '../secrets/eligibility.js'
import { secretAad } from '../secrets/store.js'
import { logAad } from '../logs/ingest.js'
import { advanceRun, finishWithoutRunning, loadGate, lockJob, lockRun, recordTransition, type JobRow, type RunRow } from './engine.js'

export interface RunnerIdentity {
  id: string
  name: string
  labels: string[]
}

export interface ClaimedJob {
  jobId: string
  runId: string
  jobKey: string
  name: string
  attempt: number
  fencingToken: number
  leaseMs: number
  repository: string
  commitSha: string
  ref: string
  branch: string
  eventType: string
  isFork: boolean
  needs: string[]
  env: Record<string, string>
  steps: JobRow['steps']
  uploads: JobRow['uploads']
  /** Delivered once, here, to the runner holding this attempt's lease. Never stored on the runner, never returned to a user. */
  secrets: Record<string, string>
  secretsWithheld: { name: string; reason: string }[]
}

export interface ClaimOptions {
  /** Seeding: restrict the claim to one job, and ignore the pause that keeps real runners away from it. */
  onlyJobId?: string
}

async function loadCandidates(client: pg.PoolClient, repoId: string, names: string[]): Promise<(SecretCandidate & { ciphertext: string; environmentId: string | null })[]> {
  if (names.length === 0) return []
  const { rows } = await client.query<{ id: string; name: string; ciphertext: string; environment_id: string | null; env_name: string | null }>(
    `SELECT s.id, s.name, s.ciphertext, s.environment_id, e.name AS env_name
       FROM secrets s LEFT JOIN environments e ON e.id = s.environment_id
      WHERE s.repo_id = $1 AND s.name = ANY($2::text[])`,
    [repoId, names],
  )
  return rows.map((r) => ({ id: r.id, name: r.name, environment: r.env_name, ciphertext: r.ciphertext, environmentId: r.environment_id }))
}

/** Releases the job's secrets under the lease being taken. The returned values go only into the claim response. */
export async function releaseSecrets(client: pg.PoolClient, run: RunRow, job: JobRow, gate: GateDecision, runner: RunnerIdentity): Promise<{ values: Record<string, string>; withheld: { name: string; reason: string }[] }> {
  const candidates = await loadCandidates(client, run.repo_id, job.requested_secrets)
  const decision = decideSecretRelease({ isFork: run.is_fork, branch: run.branch, eventType: run.event_type }, job.environment, gate, job.requested_secrets, candidates)
  const values: Record<string, string> = {}
  for (const chosen of decision.release) {
    const secret = candidates.find((c) => c.id === chosen.id)
    if (!secret) continue
    values[secret.name] = decrypt(secret.ciphertext, secretAad(run.repo_id, secret.environmentId, secret.name))
    await client.query(
      `INSERT INTO secret_releases (secret_id, secret_name, scope, repo_id, run_id, job_id, job_key, attempt, runner_id, runner_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [secret.id, secret.name, secret.environment ? `environment:${secret.environment}` : 'repository', run.repo_id, run.id, job.id, job.job_key, job.attempt, runner.id, runner.name],
    )
    secretReleases.inc()
  }
  if (decision.withheld.length > 0) secretsWithheld.inc({ reason: run.is_fork ? 'fork' : 'other' }, decision.withheld.length)
  return { values, withheld: decision.withheld }
}

async function takeLease(client: pg.PoolClient, run: RunRow, job: JobRow, runner: RunnerIdentity, gate: GateDecision): Promise<ClaimedJob> {
  const { values, withheld } = await releaseSecrets(client, run, job, gate, runner)
  const token = (await client.query<{ token: number }>(`SELECT nextval('fencing_token_seq') AS token`)).rows[0].token
  await client.query(
    `UPDATE jobs SET status = 'running', status_reason = NULL, runner_id = $2, runner_name = $3, fencing_token = $4,
            lease_expires_at = now() + make_interval(secs => $5::float8 / 1000), last_heartbeat_at = now(), started_at = now()
      WHERE id = $1`,
    [job.id, runner.id, runner.name, token, config.lease.ms],
  )
  await client.query(
    `UPDATE job_attempts SET status = 'running', status_reason = NULL, runner_id = $3, runner_name = $4, fencing_token = $5, started_at = now(), secrets_released = $6, secrets_withheld = $7
      WHERE job_id = $1 AND attempt = $2`,
    [job.id, job.attempt, runner.id, runner.name, token, Object.keys(values), JSON.stringify(withheld)],
  )
  await recordTransition(client, job, 'running', null, runner.name)
  for (const [i, step] of job.steps.entries()) {
    await client.query(`INSERT INTO step_executions (job_id, attempt, step_index, name, idempotent) VALUES ($1, $2, $3, $4, $5)`, [job.id, job.attempt, i, step.name, step.idempotent])
  }
  const aad = logAad(job.id, job.attempt)
  await client.query(`INSERT INTO log_streams (job_id, attempt, mask_enc) VALUES ($1, $2, $3)`, [job.id, job.attempt, encrypt(JSON.stringify(Object.values(values)), aad)])
  await client.query(`UPDATE workflow_runs SET status = CASE WHEN status IN ('queued', 'waiting') THEN 'running' ELSE status END, started_at = COALESCE(started_at, now()) WHERE id = $1`, [run.id])

  const { rows } = await client.query<{ full_name: string }>('SELECT full_name FROM repositories WHERE id = $1', [run.repo_id])
  if (job.queued_at) queueWait.observe(Math.max(0, (Date.now() - new Date(job.queued_at).getTime()) / 1000))
  return {
    jobId: job.id,
    runId: run.id,
    jobKey: job.job_key,
    name: job.name,
    attempt: job.attempt,
    fencingToken: token,
    leaseMs: config.lease.ms,
    repository: rows[0].full_name,
    commitSha: run.commit_sha,
    ref: run.ref,
    branch: run.branch,
    eventType: run.event_type,
    isFork: run.is_fork,
    needs: job.needs,
    env: job.env,
    steps: job.steps,
    uploads: job.uploads,
    secrets: values,
    secretsWithheld: withheld,
  }
}

const REPO_HAS_WORK = `EXISTS (SELECT 1 FROM jobs j WHERE j.repo_id = r.id AND j.status = 'queued' AND j.runs_on <@ $1::text[])`
const REPO_HAS_ROOM = `(SELECT count(*) FROM jobs j WHERE j.repo_id = r.id AND j.status = 'running') < r.max_concurrent_jobs`

export async function claimJob(runner: RunnerIdentity, options: ClaimOptions = {}): Promise<ClaimedJob | null> {
  const client = await pool.connect()
  const tried: string[] = []
  try {
    for (let i = 0; i < 6; i++) {
      await client.query('BEGIN')
      try {
        const paused = options.onlyJobId ? '' : 'AND NOT r.claims_paused'
        const only = options.onlyJobId ? `AND r.id = (SELECT repo_id FROM jobs WHERE id = $3)` : ''
        const repos = await client.query<{ id: string; max_concurrent_jobs: number }>(
          `SELECT r.id, r.max_concurrent_jobs FROM repositories r
            WHERE NOT (r.id = ANY($2::text[])) ${paused} ${only} AND ${REPO_HAS_WORK} AND ${REPO_HAS_ROOM}
            ORDER BY r.last_claimed_at NULLS FIRST, r.id
            LIMIT 1 FOR NO KEY UPDATE OF r SKIP LOCKED`,
          options.onlyJobId ? [runner.labels, tried, options.onlyJobId] : [runner.labels, tried],
        )
        const repo = repos.rows[0]
        if (!repo) {
          // Nothing unlocked. If claimable work exists behind another claimer's lock, look again shortly rather than idle.
          const busy = await client.query(`SELECT 1 FROM repositories r WHERE NOT (r.id = ANY($2::text[])) ${paused} AND ${REPO_HAS_WORK} AND ${REPO_HAS_ROOM} LIMIT 1`, [runner.labels, tried])
          await client.query('COMMIT')
          if (busy.rows.length === 0 || options.onlyJobId) {
            claims.inc({ outcome: 'empty' })
            return null
          }
          await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20))
          continue
        }

        const running = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE repo_id = $1 AND status = 'running'`, [repo.id])
        const candidate =
          running.rows[0].n < repo.max_concurrent_jobs
            ? await client.query<{ id: string; run_id: string }>(
                `SELECT id, run_id FROM jobs WHERE repo_id = $1 AND status = 'queued' AND runs_on <@ $2::text[] ${options.onlyJobId ? 'AND id = $3' : ''} ORDER BY queued_at, id LIMIT 1`,
                options.onlyJobId ? [repo.id, runner.labels, options.onlyJobId] : [repo.id, runner.labels],
              )
            : { rows: [] }
        const next = candidate.rows[0]
        if (!next) {
          await client.query('COMMIT')
          tried.push(repo.id)
          continue
        }

        const run = await lockRun(client, next.run_id)
        const job = await lockJob(client, next.id)
        if (job.status !== 'queued') {
          // Cancelled between the pick and the lock. The repository row lock serializes claims, not cancels.
          await client.query('COMMIT')
          continue
        }

        const gate = await loadGate(client, run, job)
        if (gate.action === 'deny') {
          await finishWithoutRunning(client, job, 'failure', gate.reason, 'claim-gate')
          await advanceRun(client, run, 'claim-gate')
          await client.query('COMMIT')
          claims.inc({ outcome: 'gate_denied' })
          continue
        }
        if (gate.action === 'wait') {
          await client.query(`UPDATE jobs SET status = 'waiting', status_reason = $2 WHERE id = $1`, [job.id, gate.reason])
          await client.query(`UPDATE job_attempts SET status = 'waiting', status_reason = $3 WHERE job_id = $1 AND attempt = $2`, [job.id, job.attempt, gate.reason])
          await recordTransition(client, job, 'waiting', gate.reason, 'claim-gate')
          await advanceRun(client, run, 'claim-gate')
          await client.query('COMMIT')
          claims.inc({ outcome: 'gate_denied' })
          continue
        }

        const claimed = await takeLease(client, run, job, runner, gate)
        await client.query(`UPDATE repositories SET last_claimed_at = clock_timestamp() WHERE id = $1`, [repo.id])
        await client.query('COMMIT')
        claims.inc({ outcome: 'claimed' })
        return claimed
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw err
      }
    }
    return null
  } finally {
    client.release()
  }
}
