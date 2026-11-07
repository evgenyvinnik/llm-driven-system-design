/**
 * Write side for runs: idempotent creation with fan-out, cancel, retry of
 * errored cases, and re-scoring. Each is one transaction that ends with a
 * NOTIFY, so workers wake immediately (they would also find the work by
 * polling: NOTIFY is a latency optimization, not a correctness requirement).
 * @module api/services/runs
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { config } from '../../shared/config.js'
import { canonicalJson } from '../../shared/dataset-diff.js'
import { pool, withTransaction } from '../../shared/db.js'
import { HttpError, notFound } from '../../shared/errors.js'
import { newId } from '../../shared/ids.js'
import { runsCreated } from '../../shared/metrics.js'
import { missingVariables } from '../../shared/template.js'

export const createRunSchema = z
  .object({
    name: z.string().trim().max(120).optional(),
    datasetVersionId: z.string().min(1),
    promptVersionId: z.string().min(1),
    modelConfigId: z.string().min(1),
    scorerVersionIds: z.array(z.string().min(1)).min(1).max(10),
    samplesPerCase: z.number().int().min(1).max(20),
    concurrencyLimit: z.number().int().min(1).max(64).optional(),
  })
  .strict()

export type CreateRunInput = z.infer<typeof createRunSchema>

export interface CreateRunResult {
  runId: string
  replayed: boolean
}

export async function createRun(workspaceId: string, userId: string, idempotencyKey: string, input: CreateRunInput): Promise<CreateRunResult> {
  const requestHash = createHash('sha256').update(canonicalJson({ ...input, scorerVersionIds: [...new Set(input.scorerVersionIds)].sort() })).digest('hex')

  // A retry with the same key never re-validates or re-creates: answer from the stored run.
  const existing = await pool.query<{ id: string; request_hash: string }>(
    'SELECT id, request_hash FROM eval_runs WHERE workspace_id = $1 AND created_by = $2 AND idempotency_key = $3',
    [workspaceId, userId, idempotencyKey],
  )
  if (existing.rows[0]) return replayOrConflict(existing.rows[0], requestHash)

  const pins = await pool.query<{ dv_id: string | null; pv_id: string | null; mc_id: string | null; variables: string[] | null; case_count: number | null; dataset_name: string | null; prompt_name: string | null; pv_version: number | null }>(
    `SELECT dv.id AS dv_id, pv.id AS pv_id, mc.id AS mc_id, pv.variables, dv.case_count, d.name AS dataset_name, p.name AS prompt_name, pv.version AS pv_version
       FROM (SELECT 1) x
       LEFT JOIN dataset_versions dv ON dv.id = $2 LEFT JOIN datasets d ON d.id = dv.dataset_id AND d.workspace_id = $1
       LEFT JOIN prompt_versions pv ON pv.id = $3 LEFT JOIN prompts p ON p.id = pv.prompt_id AND p.workspace_id = $1
       LEFT JOIN model_configs mc ON mc.id = $4 AND mc.workspace_id = $1`,
    [workspaceId, input.datasetVersionId, input.promptVersionId, input.modelConfigId],
  )
  const pin = pins.rows[0]
  if (!pin?.dv_id || !pin.dataset_name) throw new HttpError(422, 'UNKNOWN_DATASET_VERSION', 'Dataset version not found in this workspace')
  if (!pin.pv_id || !pin.prompt_name) throw new HttpError(422, 'UNKNOWN_PROMPT_VERSION', 'Prompt version not found in this workspace')
  if (!pin.mc_id) throw new HttpError(422, 'UNKNOWN_MODEL_CONFIG', 'Model config not found in this workspace')
  const scorerIds = [...new Set(input.scorerVersionIds)]
  const scorers = await pool.query<{ id: string }>(
    'SELECT sv.id FROM scorer_versions sv JOIN scorers s ON s.id = sv.scorer_id WHERE sv.id = ANY($1::text[]) AND s.workspace_id = $2',
    [scorerIds, workspaceId],
  )
  if (scorers.rows.length !== scorerIds.length) throw new HttpError(422, 'UNKNOWN_SCORER_VERSION', 'One or more scorer versions were not found in this workspace')
  const totalTasks = (pin.case_count ?? 0) * input.samplesPerCase
  if (totalTasks === 0) throw new HttpError(422, 'EMPTY_DATASET', 'The dataset version has no cases')
  if (totalTasks > config.runs.maxTasksPerRun) throw new HttpError(422, 'RUN_TOO_LARGE', `${totalTasks} tasks exceeds the limit of ${config.runs.maxTasksPerRun}`)

  // Fail fast on a template the cases can't fill, instead of N errored tasks later.
  const cases = await pool.query<{ case_key: string; input: Record<string, unknown> }>('SELECT case_key, input FROM dataset_cases WHERE dataset_version_id = $1', [pin.dv_id])
  const variables = pin.variables ?? []
  const broken = cases.rows.map((c) => ({ caseKey: c.case_key, missing: missingVariables(variables, c.input) })).filter((c) => c.missing.length > 0)
  if (broken.length > 0) {
    throw new HttpError(422, 'TEMPLATE_VARIABLES_MISSING', `${broken.length} case(s) lack variables the prompt uses (e.g. ${broken[0].caseKey}: ${broken[0].missing.join(', ')})`, broken.slice(0, 20))
  }

  const runId = newId('run')
  const name = input.name || `${pin.prompt_name} v${pin.pv_version} on ${pin.dataset_name}`
  return withTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO eval_runs (id, workspace_id, name, dataset_version_id, prompt_version_id, model_config_id, samples_per_case, concurrency_limit, total_tasks, created_by, idempotency_key, request_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (workspace_id, created_by, idempotency_key) DO NOTHING
       RETURNING id`,
      [runId, workspaceId, name, pin.dv_id, pin.pv_id, pin.mc_id, input.samplesPerCase, input.concurrencyLimit ?? config.runs.defaultConcurrency, totalTasks, userId, idempotencyKey, requestHash],
    )
    if (!inserted.rows[0]) {
      // A concurrent request with the same key won the insert.
      const raced = await client.query<{ id: string; request_hash: string }>('SELECT id, request_hash FROM eval_runs WHERE workspace_id = $1 AND created_by = $2 AND idempotency_key = $3', [workspaceId, userId, idempotencyKey])
      return replayOrConflict(raced.rows[0], requestHash)
    }
    await client.query(`INSERT INTO run_scorers (run_id, scorer_version_id, origin, added_by) SELECT $1, unnest($2::text[]), 'pinned', $3`, [runId, scorerIds, userId])
    // Fan-out: one row per (case, sample). Ids are derived from the key, so they are stable too.
    await client.query(
      `INSERT INTO case_results (id, run_id, case_id, case_key, sample_index)
       SELECT 'cr_' || substr(md5($1 || ':' || c.id || ':' || s.i), 1, 20), $1, c.id, c.case_key, s.i
         FROM dataset_cases c CROSS JOIN generate_series(0, $3 - 1) AS s(i)
        WHERE c.dataset_version_id = $2`,
      [runId, pin.dv_id, input.samplesPerCase],
    )
    await client.query(`SELECT pg_notify('eval_tasks', $1)`, [runId])
    runsCreated.inc({ outcome: 'created' })
    return { runId, replayed: false }
  })
}

function replayOrConflict(row: { id: string; request_hash: string }, requestHash: string): CreateRunResult {
  if (row.request_hash !== requestHash) {
    runsCreated.inc({ outcome: 'key_conflict' })
    throw new HttpError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request body', { runId: row.id })
  }
  runsCreated.inc({ outcome: 'idempotent_replay' })
  return { runId: row.id, replayed: true }
}

export async function cancelRun(workspaceId: string, runId: string): Promise<{ status: string; cancelledTasks: number; alreadyFinished: boolean }> {
  return withTransaction(async (client) => {
    const run = await client.query<{ status: string }>('SELECT status FROM eval_runs WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [runId, workspaceId])
    if (!run.rows[0]) throw notFound('Run')
    if (!['queued', 'running'].includes(run.rows[0].status)) return { status: run.rows[0].status, cancelledTasks: 0, alreadyFinished: true }
    await client.query(`UPDATE eval_runs SET status = 'cancelled', cancel_requested_at = now(), finished_at = now() WHERE id = $1`, [runId])
    const tasks = await client.query(`UPDATE case_results SET status = 'cancelled', finished_at = now() WHERE run_id = $1 AND status = 'pending'`, [runId])
    await client.query(`UPDATE scores SET status = 'cancelled' WHERE run_id = $1 AND status = 'pending'`, [runId])
    // Workers abort in-flight calls for this run on the notification (and re-check every second).
    await client.query(`SELECT pg_notify('eval_cancel', $1)`, [runId])
    return { status: 'cancelled', cancelledTasks: tasks.rowCount ?? 0, alreadyFinished: false }
  })
}

export async function retryErrored(workspaceId: string, runId: string): Promise<{ requeued: number; scoresRequeued: number; retryRound: number }> {
  return withTransaction(async (client) => {
    const run = await client.query<{ status: string; retry_round: number }>('SELECT status, retry_round FROM eval_runs WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [runId, workspaceId])
    if (!run.rows[0]) throw notFound('Run')
    const { status, retry_round } = run.rows[0]
    if (status === 'queued' || status === 'running') throw new HttpError(409, 'RUN_ACTIVE', 'The run is still executing; retry errored cases once it finishes')
    if (status === 'cancelled') throw new HttpError(409, 'RUN_CANCELLED', 'A cancelled run is not retried; start a new run')
    const tasks = await client.query(
      `UPDATE case_results SET status = 'pending', available_at = now(), round_attempts = 0, error_code = NULL, error_message = NULL, finished_at = NULL
        WHERE run_id = $1 AND status = 'errored'`,
      [runId],
    )
    const scores = await client.query(`UPDATE scores SET status = 'pending', available_at = now(), attempts = 0 WHERE run_id = $1 AND status = 'errored'`, [runId])
    const requeued = tasks.rowCount ?? 0
    const scoresRequeued = scores.rowCount ?? 0
    if (requeued + scoresRequeued === 0) return { requeued: 0, scoresRequeued: 0, retryRound: retry_round }
    await client.query(`UPDATE eval_runs SET status = 'running', retry_round = retry_round + 1, finished_at = NULL, failure_reason = NULL WHERE id = $1`, [runId])
    await client.query(`SELECT pg_notify('eval_tasks', $1)`, [runId])
    return { requeued, scoresRequeued, retryRound: retry_round + 1 }
  })
}

export async function rescoreRun(workspaceId: string, userId: string, runId: string, scorerVersionId: string): Promise<{ queued: number; alreadyScored: number; scorerVersionId: string }> {
  return withTransaction(async (client) => {
    const run = await client.query<{ status: string }>('SELECT status FROM eval_runs WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [runId, workspaceId])
    if (!run.rows[0]) throw notFound('Run')
    if (run.rows[0].status === 'queued' || run.rows[0].status === 'running') throw new HttpError(409, 'RUN_ACTIVE', 'Re-score once the run has finished')
    const sv = await client.query<{ kind: string }>('SELECT s.kind FROM scorer_versions sv JOIN scorers s ON s.id = sv.scorer_id WHERE sv.id = $1 AND s.workspace_id = $2', [scorerVersionId, workspaceId])
    if (!sv.rows[0]) throw new HttpError(422, 'UNKNOWN_SCORER_VERSION', 'Scorer version not found in this workspace')
    if (sv.rows[0].kind === 'human') throw new HttpError(422, 'HUMAN_SCORER', 'Human scores come from annotations, not re-scoring')
    await client.query(`INSERT INTO run_scorers (run_id, scorer_version_id, origin, added_by) VALUES ($1, $2, 'rescore', $3) ON CONFLICT DO NOTHING`, [runId, scorerVersionId, userId])
    // Reads stored outputs only: no generation task is created, so the model gets zero calls.
    const queued = await client.query(
      `INSERT INTO scores (case_result_id, scorer_version_id, run_id, status)
       SELECT id, $2, run_id, 'pending' FROM case_results WHERE run_id = $1 AND status = 'succeeded'
       ON CONFLICT (case_result_id, scorer_version_id) DO NOTHING`,
      [runId, scorerVersionId],
    )
    const total = await client.query<{ n: number }>(`SELECT count(*) AS n FROM case_results WHERE run_id = $1 AND status = 'succeeded'`, [runId])
    await client.query(`SELECT pg_notify('eval_tasks', $1)`, [runId])
    const q = queued.rowCount ?? 0
    return { queued: q, alreadyScored: total.rows[0].n - q, scorerVersionId }
  })
}
