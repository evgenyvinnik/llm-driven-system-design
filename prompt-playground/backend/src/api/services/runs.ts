/**
 * Run creation, cancellation, and serialization.
 *
 * Creating a run is idempotent per (user, Idempotency-Key): a retried POST
 * returns the original run instead of starting a second generation. The run
 * row is the source of truth; the Valkey queue entry is only a doorbell, and
 * the executor sweeper re-rings it if the enqueue is lost.
 */
import { z } from 'zod'
import type { SessionUser } from '../../shared/auth.js'
import { redis } from '../../shared/cache.js'
import { config } from '../../shared/config.js'
import { pool, type Queryable } from '../../shared/db.js'
import { HttpError } from '../../shared/errors.js'
import { logger } from '../../shared/logger.js'
import { runsCreated } from '../../shared/metrics.js'
import { modelConfigSchema } from '../../shared/catalog.js'
import { enforceRateLimit } from '../../shared/rate-limit.js'
import {
  appendRunEvent,
  enqueueRun,
  RUN_CANCEL_CHANNEL,
  type RunStatus,
  type RunUsage,
} from '../../shared/run-events.js'
import { extractVariables, renderTemplate, requestHash } from '../../shared/template.js'
import { loadPromptForUser, upsertSnapshot, versionForSnapshot } from './prompts.js'

export const createRunSchema = z
  .object({
    promptId: z.string().uuid(),
    system: z.string().max(20_000).default(''),
    template: z.string().min(1, 'The user message is empty').max(20_000),
    variables: z
      .record(z.string().max(10_000))
      .default({})
      .refine((v) => Object.keys(v).length <= 30, 'At most 30 variables'),
    config: modelConfigSchema,
    comparisonId: z.string().uuid().optional(),
  })
  .strict()

export type CreateRunInput = z.infer<typeof createRunSchema>

export interface RunRow {
  id: string
  workspace_id: string
  prompt_id: string
  snapshot_id: string
  version: number | null
  comparison_id: string | null
  model: string
  config: unknown
  variables: Record<string, string>
  rendered_system: string
  rendered_input: string
  status: RunStatus
  output: string
  output_truncated: boolean
  finish_reason: string | null
  error_code: string | null
  error_message: string | null
  input_tokens: number | null
  output_tokens: number | null
  attempt: number
  created_by: string
  created_by_name?: string
  saved_version?: number | null
  request_hash: string
  created_at: Date
  started_at: Date | null
  first_token_at: Date | null
  finished_at: Date | null
  cancel_requested_at: Date | null
}

/**
 * `saved_version` is computed at read time: a run of unsaved draft text whose
 * text was later saved shows which version it now matches.
 */
export const RUN_SELECT = `SELECT r.*, u.display_name AS created_by_name,
    (SELECT max(v.version) FROM prompt_versions v
      WHERE v.prompt_id = r.prompt_id AND v.snapshot_id = r.snapshot_id) AS saved_version
  FROM runs r JOIN users u ON u.id = r.created_by`

const ms = (from: Date | null, to: Date | null) => (from && to ? to.getTime() - from.getTime() : null)

export function runUsage(row: RunRow): RunUsage {
  return {
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    queueMs: ms(row.created_at, row.started_at),
    ttftMs: ms(row.started_at, row.first_token_at),
    durationMs: ms(row.started_at, row.finished_at),
  }
}

export function serializeRun(row: RunRow, opts: { includeOutput?: boolean } = {}) {
  const includeOutput = opts.includeOutput ?? true
  return {
    id: row.id,
    promptId: row.prompt_id,
    snapshotId: row.snapshot_id,
    version: row.version,
    savedVersion: row.saved_version ?? null,
    comparisonId: row.comparison_id,
    model: row.model,
    config: row.config,
    variables: row.variables,
    status: row.status,
    ...(includeOutput
      ? { output: row.output, system: row.rendered_system, input: row.rendered_input }
      : { outputPreview: row.output.slice(0, 160) }),
    outputTruncated: row.output_truncated,
    finishReason: row.finish_reason,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    usage: runUsage(row),
    attempt: row.attempt,
    cancelRequested: row.cancel_requested_at !== null,
    createdBy: { id: row.created_by, displayName: row.created_by_name ?? '' },
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  }
}

export async function loadRunForUser(db: Queryable, runId: string, user: SessionUser): Promise<RunRow> {
  const { rows } = await db.query<RunRow>(
    `${RUN_SELECT}
       JOIN workspace_members m ON m.workspace_id = r.workspace_id AND m.user_id = $2
      WHERE r.id = $1`,
    [runId, user.id],
  )
  if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Run not found')
  return rows[0]
}

async function findByIdempotencyKey(userId: string, key: string): Promise<RunRow | null> {
  const { rows } = await pool.query<RunRow>(`${RUN_SELECT} WHERE r.created_by = $1 AND r.idempotency_key = $2`, [
    userId,
    key,
  ])
  return rows[0] ?? null
}

function replayOrConflict(existing: RunRow, hash: string): { row: RunRow; replayed: true } {
  if (existing.request_hash !== hash) {
    throw new HttpError(
      422,
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used for a different request',
      { runId: existing.id },
    )
  }
  return { row: existing, replayed: true }
}

export async function createRun(
  user: SessionUser,
  input: CreateRunInput,
  idempotencyKey: string,
): Promise<{ row: RunRow; replayed: boolean }> {
  const hash = requestHash(input)

  // A retry of a request we already accepted returns the original run, even if
  // the user is now over a limit: the retry asks for nothing new.
  const existing = await findByIdempotencyKey(user.id, idempotencyKey)
  if (existing) return replayOrConflict(existing, hash)

  const prompt = await loadPromptForUser(pool, input.promptId, user)

  const used = extractVariables(input.system, input.template)
  const variables = Object.fromEntries(used.filter((name) => name in input.variables).map((n) => [n, input.variables[n]]))
  const system = renderTemplate(input.system, variables)
  const message = renderTemplate(input.template, variables)
  const missing = [...new Set([...system.missing, ...message.missing])]
  if (missing.length > 0) {
    throw new HttpError(422, 'MISSING_VARIABLES', `Fill in: ${missing.join(', ')}`, { missing })
  }

  await enforceRateLimit(`runs:${user.id}`, config.runsPerMinutePerUser, 60)
  const active = await pool.query<{ count: string }>(
    `SELECT count(*) FROM runs WHERE created_by = $1 AND status IN ('queued', 'running')`,
    [user.id],
  )
  if (Number(active.rows[0].count) >= config.maxActiveRunsPerUser) {
    throw new HttpError(
      429,
      'TOO_MANY_ACTIVE_RUNS',
      `You already have ${config.maxActiveRunsPerUser} runs in progress; wait for one to finish or stop one`,
    )
  }

  const snapshot = await upsertSnapshot(pool, prompt.id, input.system, input.template, user.id)
  const version = await versionForSnapshot(pool, prompt.id, snapshot.id)
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO runs (workspace_id, prompt_id, snapshot_id, version, comparison_id, model, config, variables,
                       rendered_system, rendered_input, created_by, idempotency_key, request_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (created_by, idempotency_key) DO NOTHING
     RETURNING id`,
    [
      prompt.workspace_id,
      prompt.id,
      snapshot.id,
      version,
      input.comparisonId ?? null,
      input.config.model,
      JSON.stringify(input.config),
      JSON.stringify(variables),
      system.text,
      message.text,
      user.id,
      idempotencyKey,
      hash,
    ],
  )

  if (inserted.rows.length === 0) {
    // A concurrent request with the same key won the insert.
    const winner = await findByIdempotencyKey(user.id, idempotencyKey)
    if (!winner) throw new HttpError(409, 'CONFLICT', 'Concurrent request; retry')
    return replayOrConflict(winner, hash)
  }

  const runId = inserted.rows[0].id
  runsCreated.inc({ model: input.config.model })
  try {
    await appendRunEvent(redis, runId, { type: 'status', status: 'queued', at: new Date().toISOString() })
    await enqueueRun(redis, runId)
  } catch (err) {
    // The run is durable in PostgreSQL; the executor sweeper re-enqueues queued runs.
    logger.warn({ err, runId }, 'enqueue failed; sweeper will retry')
  }

  const { rows } = await pool.query<RunRow>(`${RUN_SELECT} WHERE r.id = $1`, [runId])
  return { row: rows[0], replayed: false }
}

/**
 * Requests cancellation. A queued run is cancelled immediately. A running run
 * is flagged and its executor is signalled; whichever of "cancelled" or
 * "completed" is written first wins, and the caller sees the final status on
 * the run's event stream.
 */
export async function cancelRun(user: SessionUser, runId: string): Promise<RunRow> {
  await loadRunForUser(pool, runId, user)

  const queued = await pool.query<{ id: string }>(
    `UPDATE runs SET status = 'cancelled', cancel_requested_at = now(), finished_at = now()
      WHERE id = $1 AND status = 'queued'
      RETURNING id`,
    [runId],
  )
  if (queued.rows.length > 0) {
    await appendRunEvent(redis, runId, {
      type: 'end',
      status: 'cancelled',
      outputTruncated: false,
      finishReason: null,
      errorCode: null,
      errorMessage: null,
      usage: { inputTokens: null, outputTokens: null, queueMs: null, ttftMs: null, durationMs: null },
      at: new Date().toISOString(),
    })
  } else {
    const running = await pool.query(
      `UPDATE runs SET cancel_requested_at = coalesce(cancel_requested_at, now())
        WHERE id = $1 AND status = 'running'
        RETURNING id`,
      [runId],
    )
    if (running.rows.length > 0) await redis.publish(RUN_CANCEL_CHANNEL, runId)
  }
  return loadRunForUser(pool, runId, user)
}
