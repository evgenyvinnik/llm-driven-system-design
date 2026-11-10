/**
 * Materializes demo runs through the real engine, with a stand-in for a runner: the same
 * intake, claim, step, log and completion functions a live run goes through, minus the
 * child processes. So the seeded data can't drift from what the system really produces, the
 * screenshot harness gets real data with no runners up, and every run has a known id.
 *
 * `npm run demo:story` tells the same story against a live stack with real runners.
 * @module db/seed-stories
 */
import { pool } from '../shared/db.js'
import { logger } from '../shared/logger.js'
import { ensureBucket, artifactKey, putBlob } from '../shared/storage.js'
import { newId } from '../shared/ids.js'
import { sha256Hex } from '../shared/crypto.js'
import { scenarioByName } from '../fixtures/catalog.js'
import { pullRequestPayload, pushPayload } from '../fixtures/generator.js'
import { createCommit } from '../fixtures/store.js'
import { handleDelivery } from '../intake/events.js'
import { ingestChunks } from '../logs/ingest.js'
import { claimJob, type ClaimedJob, type RunnerIdentity } from '../scheduling/claim.js'
import { cancelRun, completeAttempt, decideApproval, expireLease, rerun } from '../scheduling/engine.js'
import { finishStep, startStep, type Fence } from '../scheduling/runner-ops.js'
import { REPOS } from './seed-data.js'

export const RUNNER_ONE: RunnerIdentity = { id: 'rnr_seed_1', name: 'runner-1', labels: ['linux', 'x64'] }
export const RUNNER_TWO: RunnerIdentity = { id: 'rnr_seed_2', name: 'runner-2', labels: ['linux', 'x64', 'deploy'] }

let blobsAvailable = false

async function trigger(repoId: string, scenarioName: string, runId: string, sender = 'alice', deliveryId = `seed-${runId}`): Promise<string> {
  const scenario = scenarioByName(scenarioName)
  if (!scenario) throw new Error(`No scenario ${scenarioName}`)
  const repo = REPOS.find((r) => r.id === repoId)
  if (!repo) throw new Error(`No repo ${repoId}`)
  const branch = scenario.branch ?? 'main'
  const headRepo = scenario.fork ? `contributor/${repo.fullName.split('/')[1]}` : repo.fullName
  const commit = await createCommit(pool, repoId, scenario, { branch, author: scenario.fork ? 'contributor' : sender, sourceRepo: scenario.fork ? headRepo : null })
  const payload = scenario.event === 'pull_request' ? pullRequestPayload(repo.fullName, commit, scenario.fork ? 'contributor' : sender, 42, 'main', headRepo) : pushPayload(repo.fullName, commit, sender)
  await handleDelivery({ repoId, repoFullName: repo.fullName, deliveryId, eventType: scenario.event, payload, rawBody: Buffer.from(JSON.stringify(payload)), runId })
  return runId
}

export interface ScriptedStep {
  lines: string[]
  outcome?: 'success' | 'failure' | 'timed_out'
  exitCode?: number
}

const fenceOf = (job: ClaimedJob, runner: RunnerIdentity): Fence => ({ jobId: job.jobId, attempt: job.attempt, fencingToken: job.fencingToken, runnerId: runner.id })

async function claimKey(runId: string, key: string, runner: RunnerIdentity): Promise<ClaimedJob> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM jobs WHERE run_id = $1 AND job_key = $2', [runId, key])
  const job = await claimJob(runner, { onlyJobId: rows[0].id })
  if (!job) throw new Error(`Could not claim ${key} of ${runId}`)
  return job
}

/** Runs one job to its end: the steps in `script`, in order, until one fails. */
async function perform(runId: string, key: string, runner: RunnerIdentity, script: ScriptedStep[], artifact?: { name: string; content: string; retentionDays: number }): Promise<void> {
  const job = await claimKey(runId, key, runner)
  const fence = fenceOf(job, runner)
  let seq = 0
  await ingestChunks(fence, [{ seq: ++seq, stepIndex: 0, text: `[runner] checked out ${job.commitSha.slice(0, 12)} into a fresh workspace (attempt ${job.attempt})\n` }])
  for (const w of job.secretsWithheld) await ingestChunks(fence, [{ seq: ++seq, stepIndex: 0, text: `[runner] secret ${w.name} withheld: ${w.reason}\n` }])
  let conclusion: 'success' | 'failure' = 'success'
  let reason: string | null = null
  for (const [index, step] of job.steps.entries()) {
    const planned = script[index]
    if (!planned) break
    await startStep(fence, index)
    const lines = [`[runner] ▶ ${step.name}${step.idempotent ? '' : ' (non-idempotent)'}`, ...planned.lines, `[runner] ${step.name}: ${planned.outcome ?? 'success'} (exit ${planned.exitCode ?? 0})`]
    await ingestChunks(fence, [{ seq: ++seq, stepIndex: index, text: `${lines.join('\n')}\n` }])
    await finishStep(fence, index, planned.outcome ?? 'success', planned.exitCode ?? 0)
    if ((planned.outcome ?? 'success') !== 'success') {
      conclusion = 'failure'
      reason = `Step "${step.name}" exited ${planned.exitCode ?? 1}`
      break
    }
  }
  if (artifact && conclusion === 'success' && blobsAvailable) {
    const { rows } = await pool.query<{ repo_id: string }>('SELECT repo_id FROM jobs WHERE id = $1', [job.jobId])
    const bytes = Buffer.from(artifact.content)
    const objectKey = artifactKey(rows[0].repo_id, runId, job.jobId, job.attempt, artifact.name)
    await putBlob(objectKey, bytes, 'application/octet-stream')
    await pool.query(
      `INSERT INTO artifacts (id, repo_id, run_id, job_id, job_key, attempt, name, object_key, size_bytes, sha256, retention_days, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + make_interval(days => $11))`,
      [newId('art'), rows[0].repo_id, runId, job.jobId, key, job.attempt, artifact.name, objectKey, bytes.length, sha256Hex(bytes), artifact.retentionDays],
    )
  }
  await completeAttempt(job.jobId, job.attempt, job.fencingToken, { conclusion, reason })
}

/** A runner that vanishes mid-step: logs and a started step, then silence until the lease is swept. */
async function vanish(runId: string, key: string, runner: RunnerIdentity, finished: ScriptedStep[], running: string[]): Promise<void> {
  const job = await claimKey(runId, key, runner)
  const fence = fenceOf(job, runner)
  let seq = 0
  await ingestChunks(fence, [{ seq: ++seq, stepIndex: 0, text: `[runner] checked out ${job.commitSha.slice(0, 12)} into a fresh workspace (attempt ${job.attempt})\n` }])
  for (const [index, planned] of finished.entries()) {
    await startStep(fence, index)
    await ingestChunks(fence, [{ seq: ++seq, stepIndex: index, text: `[runner] ▶ ${job.steps[index].name}\n${planned.lines.join('\n')}\n` }])
    await finishStep(fence, index, 'success', 0)
  }
  const current = finished.length
  await startStep(fence, current)
  const step = job.steps[current]
  await ingestChunks(fence, [{ seq: seq + 1, stepIndex: current, text: `[runner] ▶ ${step.name}${step.idempotent ? '' : ' (non-idempotent)'}\n${running.join('\n')}\n` }])
  await pool.query(`UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [job.jobId])
  await expireLease(job.jobId)
}

const quick = (...lines: string[]): ScriptedStep => ({ lines })

const DIAMOND = async (runId: string, sha: () => Promise<string>) => {
  const commit = await sha()
  await perform(runId, 'build', RUNNER_ONE, [quick(`commit ${commit}`, 'hello from the fixture repository'), quick('compile unit 1', 'compile unit 2', 'compile unit 3')], { name: 'app-bundle', content: `bundle of ${commit}\n`, retentionDays: 14 })
  await perform(runId, 'test-unit', RUNNER_ONE, [quick(`bundle of ${commit}`), quick('ok 1 - unit', 'ok 2 - unit', 'ok 3 - unit', 'ok 4 - unit')])
  await perform(runId, 'test-integration', RUNNER_TWO, [quick(`bundle of ${commit}`), quick('ok 1 - integration', 'ok 2 - integration', 'ok 3 - integration')])
  await perform(runId, 'package', RUNNER_ONE, [quick('packaged after both test jobs, attempt 1')])
}

const commitOf = (runId: string) => async () => (await pool.query<{ commit_sha: string }>('SELECT commit_sha FROM workflow_runs WHERE id = $1', [runId])).rows[0].commit_sha

async function jobIdOf(runId: string, key: string): Promise<string> {
  return (await pool.query<{ id: string }>('SELECT id FROM jobs WHERE run_id = $1 AND job_key = $2', [runId, key])).rows[0].id
}

const deployBuild = async (runId: string, commit: string) => {
  await perform(runId, 'build', RUNNER_ONE, [quick('registry token is ***', 'installed'), quick('compiled')], { name: 'release', content: `release of ${commit}\n`, retentionDays: 30 })
}

/**
 * Stable durations and a spread of start times, so seeded lists read like a real history
 * instead of everything having happened in the same second. The derived facts (which attempt,
 * which status) are all real; only the clock is rewritten.
 */
async function spreadInTime(runId: string, minutesAgo: number): Promise<void> {
  const base = new Date(Date.now() - minutesAgo * 60_000)
  const { rows: jobs } = await pool.query<{ id: string; needs: string[]; job_key: string }>('SELECT id, needs, job_key FROM jobs WHERE run_id = $1', [runId])
  const layer = new Map<string, number>()
  const depth = (key: string): number => {
    if (layer.has(key)) return layer.get(key) as number
    const job = jobs.find((j) => j.job_key === key)
    const d = (job?.needs ?? []).reduce((max, dep) => Math.max(max, depth(dep) + 1), 0)
    layer.set(key, d)
    return d
  }
  await pool.query('UPDATE trigger_events SET created_at = $2, last_received_at = $2 WHERE run_id = $1', [runId, base])
  await pool.query(`UPDATE workflow_runs SET created_at = $2, started_at = CASE WHEN started_at IS NULL THEN NULL ELSE $2::timestamptz + interval '2 seconds' END WHERE id = $1`, [runId, base])
  let latest = base.getTime()
  for (const job of jobs) {
    const { rows: attempts } = await pool.query<{ attempt: number; finished_at: Date | null; started_at: Date | null; run_attempt: number }>('SELECT attempt, finished_at, started_at, run_attempt FROM job_attempts WHERE job_id = $1 ORDER BY attempt', [job.id])
    for (const a of attempts) {
      const attemptBase = base.getTime() + (a.attempt - 1) * 240_000 + depth(job.job_key) * 45_000
      const seconds = 8 + (Number.parseInt(sha256Hex(job.id).slice(0, 2), 16) % 30)
      const started = new Date(attemptBase + 3000)
      const finished = new Date(attemptBase + 3000 + seconds * 1000)
      if (a.started_at) {
        await pool.query(`UPDATE job_attempts SET queued_at = $3, started_at = $4, finished_at = CASE WHEN finished_at IS NULL THEN NULL ELSE $5::timestamptz END, created_at = $3 WHERE job_id = $1 AND attempt = $2`, [job.id, a.attempt, new Date(attemptBase), started, finished])
        const { rows: steps } = await pool.query<{ step_index: number; started_at: Date | null; finished_at: Date | null }>('SELECT step_index, started_at, finished_at FROM step_executions WHERE job_id = $1 AND attempt = $2 ORDER BY step_index', [job.id, a.attempt])
        const total = Math.max(1, steps.filter((s) => s.started_at).length)
        for (const s of steps) {
          if (!s.started_at) continue
          const stepStart = new Date(started.getTime() + (s.step_index * seconds * 1000) / total)
          const stepEnd = new Date(stepStart.getTime() + (seconds * 1000) / total)
          await pool.query('UPDATE step_executions SET started_at = $4, finished_at = CASE WHEN finished_at IS NULL THEN NULL ELSE $5::timestamptz END WHERE job_id = $1 AND attempt = $2 AND step_index = $3', [job.id, a.attempt, s.step_index, stepStart, stepEnd])
        }
        await pool.query(`UPDATE log_lines SET at = $3 WHERE job_id = $1 AND attempt = $2`, [job.id, a.attempt, started])
      } else if (a.finished_at) {
        await pool.query('UPDATE job_attempts SET finished_at = $3, created_at = $3 WHERE job_id = $1 AND attempt = $2', [job.id, a.attempt, finished])
      } else {
        await pool.query('UPDATE job_attempts SET created_at = $3 WHERE job_id = $1 AND attempt = $2', [job.id, a.attempt, new Date(attemptBase)])
      }
      if (a.attempt === attempts[attempts.length - 1].attempt) {
        await pool.query(
          `UPDATE jobs SET queued_at = CASE WHEN queued_at IS NULL THEN NULL ELSE $2::timestamptz END, started_at = CASE WHEN started_at IS NULL THEN NULL ELSE $3::timestamptz END, finished_at = CASE WHEN finished_at IS NULL THEN NULL ELSE $4::timestamptz END WHERE id = $1`,
          [job.id, new Date(attemptBase), started, finished],
        )
      }
      latest = Math.max(latest, finished.getTime())
      await pool.query('UPDATE job_transitions SET at = $3 WHERE job_id = $1 AND attempt = $2', [job.id, a.attempt, started])
    }
  }
  await pool.query('UPDATE workflow_runs SET finished_at = CASE WHEN finished_at IS NULL THEN NULL ELSE $2::timestamptz END WHERE id = $1', [runId, new Date(latest)])
  await pool.query('UPDATE secret_releases SET released_at = $2 WHERE run_id = $1', [runId, new Date(base.getTime() + 3000)])
  await pool.query('UPDATE environment_approvals SET decided_at = $2 WHERE job_id = ANY($1::text[])', [jobs.map((j) => j.id), new Date(base.getTime() + 30_000)])
}

export async function materializeStories(): Promise<void> {
  blobsAvailable = await ensureBucket().then(
    () => true,
    (err: Error) => {
      logger.warn({ err: err.message }, 'blob store not reachable: seeding without artifact bytes')
      return false
    },
  )

  // A push, all green, with a redelivered webhook that changed nothing.
  await trigger('repo_webapp', 'diamond', 'run_demo_success')
  await DIAMOND('run_demo_success', commitOf('run_demo_success'))
  const original = await pool.query<{ event_type: string; payload: unknown }>(`SELECT event_type, payload FROM trigger_events WHERE delivery_id = 'seed-run_demo_success'`)
  for (let i = 0; i < 2; i++) {
    await handleDelivery({ repoId: 'repo_webapp', repoFullName: 'acme/web-app', deliveryId: 'seed-run_demo_success', eventType: original.rows[0].event_type, payload: original.rows[0].payload, rawBody: Buffer.from(JSON.stringify(original.rows[0].payload)) })
  }
  await spreadInTime('run_demo_success', 190)

  // A test fails: everything downstream is skipped, with the reason.
  await trigger('repo_webapp', 'failing', 'run_demo_failed')
  await perform('run_demo_failed', 'lint', RUNNER_ONE, [quick('0 problems')])
  await perform('run_demo_failed', 'test', RUNNER_TWO, [{ lines: ['ok 1 - parses config', 'not ok 2 - totals round correctly', 'expected 10.00, got 9.99'], outcome: 'failure', exitCode: 1 }])
  await spreadInTime('run_demo_failed', 160)

  // A flaky test: re-run failed gives the failed job and its dependents new attempts; the build keeps attempt 1.
  await trigger('repo_webapp', 'flaky', 'run_demo_rerun')
  await perform('run_demo_rerun', 'build', RUNNER_ONE, [quick('compiled at attempt 1')], { name: 'app-bundle', content: 'bundle\n', retentionDays: 7 })
  await perform('run_demo_rerun', 'test', RUNNER_ONE, [{ lines: ['running attempt 1 of this job', 'connection reset by test database'], outcome: 'failure', exitCode: 1 }])
  await rerun({ runId: 'run_demo_rerun', mode: 'failed', actor: 'alice', confirmNonIdempotent: false })
  await perform('run_demo_rerun', 'test', RUNNER_TWO, [quick('running attempt 2 of this job', 'all tests passed')])
  await perform('run_demo_rerun', 'report', RUNNER_ONE, [quick('report for attempt 2')])
  await spreadInTime('run_demo_rerun', 130)

  // A runner dies during an idempotent build: lease expiry, a new attempt elsewhere, and the job finishes.
  await trigger('repo_webapp', 'killable', 'run_demo_lease')
  await vanish('run_demo_lease', 'long-build', RUNNER_ONE, [quick('prepared on attempt 1')], ['compiling 1', 'compiling 2', 'compiling 3'])
  await perform('run_demo_lease', 'long-build', RUNNER_TWO, [quick('prepared on attempt 2'), quick('compiled on attempt 2')])
  await perform('run_demo_lease', 'after', RUNNER_ONE, [quick('ran after the retried build')])
  await spreadInTime('run_demo_lease', 100)

  // A fork pull request: secrets withheld, and its deploy job can't enter production.
  await trigger('repo_webapp', 'fork-pr', 'run_demo_fork', 'contributor')
  await perform('run_demo_fork', 'test', RUNNER_ONE, [quick('NPM_TOKEN is [not set]', 'DEPLOY_TOKEN is [not set]', 'CI=true', 'HOME=/tmp/ci-cd-runner/runner-1/test-a1/workspace', 'PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'), quick('ok 1 - contribution looks fine')])
  await spreadInTime('run_demo_fork', 75)

  // A rejected workflow: the error is on the run.
  await trigger('repo_webapp', 'cycle', 'run_demo_invalid')
  await spreadInTime('run_demo_invalid', 60)

  // A cancelled run: the running job was told through its heartbeat.
  await trigger('repo_webapp', 'cancellable', 'run_demo_cancelled')
  {
    const job = await claimKey('run_demo_cancelled', 'sleeper', RUNNER_ONE)
    const fence = fenceOf(job, RUNNER_ONE)
    await ingestChunks(fence, [{ seq: 1, stepIndex: 0, text: '[runner] ▶ Spawn a process tree\nchild_pid=48210\nshell_pid=48209\ngrandchild_pid=48212\n' }])
    await startStep(fence, 0)
    await cancelRun('run_demo_cancelled', 'alice')
    await ingestChunks(fence, [{ seq: 2, stepIndex: 0, text: '[runner] Spawn a process tree: killed in 4.1s\n' }])
    await finishStep(fence, 0, 'killed', null)
    await completeAttempt(job.jobId, job.attempt, job.fencingToken, { conclusion: 'cancelled', reason: 'Step "Spawn a process tree" was killed' })
  }
  await spreadInTime('run_demo_cancelled', 45)

  // Masking: the workflow prints secrets carelessly; the log shows only ***.
  await trigger('repo_webapp', 'secrets', 'run_demo_secrets')
  await perform('run_demo_secrets', 'print', RUNNER_ONE, [quick('whole: ***', 'env-scoped: ***'), quick('split: *** end'), quick('***')])
  await spreadInTime('run_demo_secrets', 35)

  // Deploy waiting for a person.
  await trigger('repo_webapp', 'deploy', 'run_demo_waiting')
  await deployBuild('run_demo_waiting', await commitOf('run_demo_waiting')())
  await spreadInTime('run_demo_waiting', 20)

  // The runner vanished during the deploy: outcome unknown, a person decides.
  await trigger('repo_webapp', 'deploy', 'run_demo_attention')
  await deployBuild('run_demo_attention', await commitOf('run_demo_attention')())
  await decideApproval(await jobIdOf('run_demo_attention', 'deploy'), 'approved', 'alice', 'Release window is open')
  await vanish('run_demo_attention', 'deploy', RUNNER_TWO, [quick('release of the bundle', 'deploying with ***')], ['pushing release to production...'])
  await spreadInTime('run_demo_attention', 8)

  // A deployment that a person resolved: it landed, so the smoke test ran.
  await trigger('repo_payments', 'deploy', 'run_pay_resolved')
  await deployBuild('run_pay_resolved', await commitOf('run_pay_resolved')())
  await decideApproval(await jobIdOf('run_pay_resolved', 'deploy'), 'approved', 'alice', null)
  await vanish('run_pay_resolved', 'deploy', RUNNER_TWO, [quick('deploying with ***')], ['pushing release to production...'])
  const { resolveAttention } = await import('../scheduling/engine.js')
  await resolveAttention({ jobId: await jobIdOf('run_pay_resolved', 'deploy'), decision: 'succeeded', note: 'Checked the load balancer: the new version is serving', actor: 'alice', confirmRetry: false })
  await perform('run_pay_resolved', 'smoke', RUNNER_ONE, [quick('production responded 200')])
  await spreadInTime('run_pay_resolved', 150)

  await trigger('repo_payments', 'diamond', 'run_pay_green')
  await DIAMOND('run_pay_green', commitOf('run_pay_green'))
  await spreadInTime('run_pay_green', 25)

  // Another organization's repository: bob's view, and what nobody at Acme can see.
  await trigger('repo_portal', 'diamond', 'run_portal_green', 'bob')
  await DIAMOND('run_portal_green', commitOf('run_portal_green'))
  await spreadInTime('run_portal_green', 55)
  await trigger('repo_portal', 'failing', 'run_portal_failed', 'bob')
  await perform('run_portal_failed', 'lint', RUNNER_ONE, [quick('0 problems')])
  await perform('run_portal_failed', 'test', RUNNER_ONE, [{ lines: ['not ok 1 - portal layout', 'snapshot differs'], outcome: 'failure', exitCode: 1 }])
  await spreadInTime('run_portal_failed', 15)

  await pool.query(`UPDATE repositories SET last_claimed_at = now() - interval '5 minutes'`)
}
