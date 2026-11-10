/**
 * Turning a verified webhook into a run. Everything happens in one transaction:
 * the delivery row, the pins, the run, the job rows and the first readiness pass. So
 * a delivery either produced a complete run or nothing, and a redelivery of the same
 * id finds the row and returns the same run, even if the two arrive at once (the
 * second insert waits on the unique index until the first commits).
 * @module intake/events
 */
import { z } from 'zod'
import { sha256Hex } from '../shared/crypto.js'
import { withTransaction } from '../shared/db.js'
import { HttpError } from '../shared/errors.js'
import { newId } from '../shared/ids.js'
import { webhookOutcomes } from '../shared/metrics.js'
import { getCommit } from '../fixtures/store.js'
import { advanceRun, type RunRow } from '../scheduling/engine.js'
import { matchesTrigger, parseWorkflow } from '../workflow/parser.js'
import type { ParsedJob, WorkflowError } from '../workflow/types.js'

export const WORKFLOW_PATH = '.ci/workflow.yml'

const pushSchema = z.object({
  ref: z.string().min(1),
  after: z.string().min(1),
  repository: z.object({ full_name: z.string() }),
  sender: z.object({ login: z.string() }).optional(),
  pusher: z.object({ name: z.string() }).optional(),
})

const prSchema = z.object({
  action: z.string(),
  repository: z.object({ full_name: z.string() }),
  sender: z.object({ login: z.string() }).optional(),
  pull_request: z.object({
    number: z.number().int(),
    head: z.object({ sha: z.string().min(1), ref: z.string(), repo: z.object({ full_name: z.string(), fork: z.boolean().optional() }).nullable().optional() }),
    base: z.object({ ref: z.string() }),
  }),
})

export interface NormalizedEvent {
  eventType: 'push' | 'pull_request'
  action: string | null
  ref: string
  /** What environment branch rules compare against. For a pull request this is never a real branch name. */
  branch: string
  /** What the workflow's `on:` branch filter compares against. */
  filterBranch: string
  commitSha: string
  sender: string
  isFork: boolean
  headRepo: string | null
  prNumber: number | null
  repository: string
}

const PR_ACTIONS = new Set(['opened', 'synchronize', 'reopened'])

/**
 * The trust decision on untrusted input from a signed source. Fails closed: a head
 * repository the payload doesn't name (a deleted fork) counts as a fork. A pull request's
 * `branch` is `pull/N/merge`, so a fork that names its branch `main` can't satisfy a
 * branch rule that says `main`.
 */
export function normalizeEvent(eventType: string, payload: unknown): NormalizedEvent | { ignored: string } {
  if (eventType === 'push') {
    const p = pushSchema.parse(payload)
    if (!p.ref.startsWith('refs/heads/')) return { ignored: `Refs other than branches are not built (${p.ref})` }
    if (/^0+$/.test(p.after)) return { ignored: 'Branch deletion' }
    const branch = p.ref.slice('refs/heads/'.length)
    return { eventType: 'push', action: null, ref: p.ref, branch, filterBranch: branch, commitSha: p.after, sender: p.sender?.login ?? p.pusher?.name ?? 'unknown', isFork: false, headRepo: null, prNumber: null, repository: p.repository.full_name }
  }
  if (eventType === 'pull_request') {
    const p = prSchema.parse(payload)
    if (!PR_ACTIONS.has(p.action)) return { ignored: `Pull request action "${p.action}" does not start a run` }
    const head = p.pull_request.head
    const headRepo = head.repo?.full_name ?? null
    const isFork = head.repo?.fork === true || headRepo !== p.repository.full_name
    return {
      eventType: 'pull_request',
      action: p.action,
      ref: `refs/pull/${p.pull_request.number}/merge`,
      branch: `pull/${p.pull_request.number}/merge`,
      filterBranch: p.pull_request.base.ref,
      commitSha: head.sha,
      sender: p.sender?.login ?? 'unknown',
      isFork,
      headRepo,
      prNumber: p.pull_request.number,
      repository: p.repository.full_name,
    }
  }
  return { ignored: `Event "${eventType}" is not handled` }
}

export interface DeliveryInput {
  repoId: string
  repoFullName: string
  deliveryId: string
  eventType: string
  payload: unknown
  rawBody: Buffer
  /** Seeding only: stable ids, so screenshots can link to a known run. */
  runId?: string
}

export interface DeliveryResult {
  duplicate: boolean
  runId: string | null
  runNumber: number | null
  outcome: string
  detail: string | null
  errors?: WorkflowError[]
}

export async function handleDelivery(input: DeliveryInput): Promise<DeliveryResult> {
  const event = normalizeEvent(input.eventType, input.payload)
  if ('ignored' in event) {
    webhookOutcomes.inc({ outcome: 'ignored' })
    return { duplicate: false, runId: null, runNumber: null, outcome: 'ignored', detail: event.ignored }
  }
  if (event.repository !== input.repoFullName) throw new HttpError(400, 'REPOSITORY_MISMATCH', 'The payload names a different repository than this webhook URL')

  const result = await withTransaction((client) => intakeTransaction(client, input, event))
  webhookOutcomes.inc({ outcome: result.duplicate ? 'duplicate' : result.errors ? 'invalid_workflow' : result.outcome })
  return result
}

type Tx = Parameters<Parameters<typeof withTransaction>[0]>[0]

async function intakeTransaction(client: Tx, input: DeliveryInput, event: NormalizedEvent): Promise<DeliveryResult> {
  const eventId = newId('evt')
  const inserted = await client.query(
    `INSERT INTO trigger_events (id, repo_id, delivery_id, event_type, action, ref, branch, commit_sha, sender, pr_number, head_repo, is_fork, payload_sha256, payload, outcome)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'pending')
     ON CONFLICT (repo_id, delivery_id) DO NOTHING RETURNING id`,
    [eventId, input.repoId, input.deliveryId, event.eventType, event.action, event.ref, event.branch, event.commitSha, event.sender, event.prNumber, event.headRepo, event.isFork, sha256Hex(input.rawBody), JSON.stringify(input.payload)],
  )
  if (inserted.rows.length === 0) {
    const { rows } = await client.query<{ run_id: string | null; outcome: string; outcome_detail: string | null; run_number: number | null }>(
      `UPDATE trigger_events t SET redeliveries = redeliveries + 1, last_received_at = now()
         FROM (SELECT id, (SELECT run_number FROM workflow_runs r WHERE r.id = e.run_id) AS run_number FROM trigger_events e WHERE repo_id = $1 AND delivery_id = $2) x
        WHERE t.id = x.id RETURNING t.run_id, t.outcome, t.outcome_detail, x.run_number`,
      [input.repoId, input.deliveryId],
    )
    return { duplicate: true, runId: rows[0].run_id, runNumber: rows[0].run_number, outcome: rows[0].outcome, detail: rows[0].outcome_detail }
  }

  const finish = async (outcome: string, detail: string | null, runId: string | null = null) => {
    await client.query('UPDATE trigger_events SET outcome = $2, outcome_detail = $3, run_id = $4 WHERE id = $1', [eventId, outcome, detail, runId])
  }

  const commit = await getCommit(client, input.repoId, event.commitSha)
  if (!commit) {
    await finish('unknown_commit', `Commit ${event.commitSha} is not in the fixture store`)
    return { duplicate: false, runId: null, runNumber: null, outcome: 'unknown_commit', detail: `Commit ${event.commitSha} not found` }
  }
  const source = commit.tree[WORKFLOW_PATH]
  if (source === undefined) {
    await finish('no_workflow', `No ${WORKFLOW_PATH} at this commit`)
    return { duplicate: false, runId: null, runNumber: null, outcome: 'no_workflow', detail: `No ${WORKFLOW_PATH} at this commit` }
  }

  const parsed = parseWorkflow(source)
  if (parsed.ok && !matchesTrigger(parsed.workflow, event.eventType, event.filterBranch)) {
    await finish('filtered', `The workflow's on: filter does not match ${event.eventType} on ${event.filterBranch}`)
    return { duplicate: false, runId: null, runNumber: null, outcome: 'filtered', detail: `on: filter does not match ${event.eventType} on ${event.filterBranch}` }
  }

  const workflowSha = sha256Hex(source)
  await client.query('INSERT INTO workflow_files (sha, content) VALUES ($1, $2) ON CONFLICT DO NOTHING', [workflowSha, source])
  const counter = await client.query<{ number: number }>(
    `INSERT INTO repo_run_counters (repo_id, next_number) VALUES ($1, 2)
     ON CONFLICT (repo_id) DO UPDATE SET next_number = repo_run_counters.next_number + 1 RETURNING next_number - 1 AS number`,
    [input.repoId],
  )
  const runNumber = counter.rows[0].number
  const runId = input.runId ?? newId('run')
  const errors = parsed.ok ? null : parsed.errors
  const runs = await client.query<RunRow>(
    `INSERT INTO workflow_runs (id, repo_id, run_number, trigger_event_id, event_type, ref, branch, commit_sha, commit_message, workflow_path, workflow_sha, workflow_name, is_fork, head_repo, pr_number, sender, status, error_code, error_message, error_details, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) RETURNING *`,
    [
      runId,
      input.repoId,
      runNumber,
      eventId,
      event.eventType,
      event.ref,
      event.branch,
      event.commitSha,
      commit.message,
      WORKFLOW_PATH,
      workflowSha,
      parsed.ok ? parsed.workflow.name : '(invalid workflow)',
      event.isFork,
      event.headRepo,
      event.prNumber,
      event.sender,
      errors ? 'invalid' : 'queued',
      errors ? errors[0].code : null,
      errors ? errors.map((e) => e.message).join('; ') : null,
      errors ? JSON.stringify(errors) : null,
      errors ? new Date() : null,
    ],
  )
  await finish('created_run', null, runId)
  if (errors || !parsed.ok) return { duplicate: false, runId, runNumber, outcome: 'created_run', detail: 'The workflow file was rejected', errors: errors ?? [] }

  for (const job of parsed.workflow.jobs) await insertJob(client, runId, input.repoId, job, input.runId ? `job_${runId}_${job.key}` : newId('job'))
  await advanceRun(client, runs.rows[0], 'intake')
  return { duplicate: false, runId, runNumber, outcome: 'created_run', detail: null }
}

async function insertJob(client: Tx, runId: string, repoId: string, job: ParsedJob, jobId: string): Promise<void> {
  await client.query(
    `INSERT INTO jobs (id, run_id, repo_id, job_key, name, needs, runs_on, environment, requested_secrets, env, steps, uploads, matrix, has_non_idempotent, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'blocked')`,
    [
      jobId,
      runId,
      repoId,
      job.key,
      job.name,
      job.needs,
      job.runsOn,
      job.environment,
      job.secrets,
      JSON.stringify(job.env),
      JSON.stringify(job.steps),
      JSON.stringify(job.uploads),
      job.matrix ? JSON.stringify(job.matrix) : null,
      job.steps.some((s) => !s.idempotent),
    ],
  )
  await client.query(`INSERT INTO job_attempts (job_id, attempt, run_id, run_attempt, trigger, status) VALUES ($1, 1, $2, 1, 'initial', 'blocked')`, [jobId, runId])
  await client.query(`INSERT INTO job_transitions (job_id, run_id, attempt, from_status, to_status, actor) VALUES ($1, $2, 1, NULL, 'blocked', 'intake')`, [jobId, runId])
}
