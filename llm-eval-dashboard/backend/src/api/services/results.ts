/**
 * Read side for runs: pins, progress, usage and per-scorer aggregates, all
 * computed on read from case_results and scores (see shared/aggregate.ts).
 * Every query is scoped to the caller's workspace.
 * @module api/services/results
 */
import { aggregateRun, type RunAggregate, type SampleRow, type TaskStatus } from '../../shared/aggregate.js'
import type { Queryable } from '../../shared/db.js'
import { notFound } from '../../shared/errors.js'
import type { RunPins } from '../../shared/provenance.js'

export interface RunHeader {
  id: string
  name: string
  status: RunPins['status']
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  cancelRequestedAt: string | null
  createdBy: string
  retryRound: number
  failureReason: string | null
  samplesPerCase: number
  concurrencyLimit: number
  totalTasks: number
  dataset: { id: string; name: string; versionId: string; version: number; caseCount: number }
  prompt: { id: string; name: string; versionId: string; version: number }
  modelConfig: { id: string; name: string; model: string; temperature: number; maxTokens: number; seed: number }
}

const HEADER_SQL = `
  SELECT r.id, r.name, r.status, r.created_at, r.started_at, r.finished_at, r.cancel_requested_at, u.display_name AS created_by,
         r.retry_round, r.failure_reason, r.samples_per_case, r.concurrency_limit, r.total_tasks,
         d.id AS dataset_id, d.name AS dataset_name, dv.id AS dataset_version_id, dv.version AS dataset_version, dv.case_count,
         p.id AS prompt_id, p.name AS prompt_name, pv.id AS prompt_version_id, pv.version AS prompt_version,
         mc.id AS mc_id, mc.name AS mc_name, mc.model, mc.temperature, mc.max_tokens, mc.seed
    FROM eval_runs r
    JOIN users u ON u.id = r.created_by
    JOIN dataset_versions dv ON dv.id = r.dataset_version_id JOIN datasets d ON d.id = dv.dataset_id
    JOIN prompt_versions pv ON pv.id = r.prompt_version_id JOIN prompts p ON p.id = pv.prompt_id
    JOIN model_configs mc ON mc.id = r.model_config_id`

type HeaderRow = Record<string, unknown> & { created_at: Date; started_at: Date | null; finished_at: Date | null; cancel_requested_at: Date | null }
const iso = (d: Date | null) => (d ? d.toISOString() : null)

function toHeader(r: HeaderRow): RunHeader {
  return {
    id: r.id as string,
    name: r.name as string,
    status: r.status as RunHeader['status'],
    createdAt: r.created_at.toISOString(),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    cancelRequestedAt: iso(r.cancel_requested_at),
    createdBy: r.created_by as string,
    retryRound: r.retry_round as number,
    failureReason: (r.failure_reason as string | null) ?? null,
    samplesPerCase: r.samples_per_case as number,
    concurrencyLimit: r.concurrency_limit as number,
    totalTasks: r.total_tasks as number,
    dataset: { id: r.dataset_id as string, name: r.dataset_name as string, versionId: r.dataset_version_id as string, version: r.dataset_version as number, caseCount: r.case_count as number },
    prompt: { id: r.prompt_id as string, name: r.prompt_name as string, versionId: r.prompt_version_id as string, version: r.prompt_version as number },
    modelConfig: { id: r.mc_id as string, name: r.mc_name as string, model: r.model as string, temperature: r.temperature as number, maxTokens: r.max_tokens as number, seed: r.seed as number },
  }
}

export async function loadRunHeader(db: Queryable, workspaceId: string, runId: string): Promise<RunHeader> {
  const { rows } = await db.query<HeaderRow>(`${HEADER_SQL} WHERE r.id = $1 AND r.workspace_id = $2`, [runId, workspaceId])
  if (!rows[0]) throw notFound('Run')
  return toHeader(rows[0])
}

export async function listRunHeaders(db: Queryable, workspaceId: string, limit = 100): Promise<RunHeader[]> {
  const { rows } = await db.query<HeaderRow>(`${HEADER_SQL} WHERE r.workspace_id = $1 ORDER BY r.created_at DESC LIMIT $2`, [workspaceId, limit])
  return rows.map(toHeader)
}

export interface RunScorer {
  scorerVersionId: string
  scorerId: string
  name: string
  kind: string
  version: number
  origin: 'pinned' | 'rescore'
  addedAt: string
  coverage: { scored: number; pending: number; errored: number; cancelled: number }
  /** Every succeeded output has a finished score row (scored or errored), and nothing is pending. */
  complete: boolean
  aggregate: RunAggregate
}

export interface RunResults {
  progress: Record<TaskStatus, number>
  usage: { inputTokens: number; outputTokens: number; modelCalls: number; avgQueueMs: number | null; avgTtftMs: number | null; avgGenerationMs: number | null; liveLeases: number }
  scorers: RunScorer[]
}

/** Progress, usage and one aggregate per scorer version attached to the run. */
export async function loadRunResults(db: Queryable, runId: string): Promise<RunResults> {
  const [tasks, scores, scorers, usage] = await Promise.all([
    db.query<{ id: string; case_key: string; sample_index: number; status: TaskStatus }>('SELECT id, case_key, sample_index, status FROM case_results WHERE run_id = $1', [runId]),
    db.query<{ case_result_id: string; scorer_version_id: string; status: string; score: number | null; passed: boolean | null }>(
      'SELECT case_result_id, scorer_version_id, status, score, passed FROM scores WHERE run_id = $1',
      [runId],
    ),
    db.query<{ scorer_version_id: string; origin: 'pinned' | 'rescore'; added_at: Date; scorer_id: string; name: string; kind: string; version: number }>(
      `SELECT rs.scorer_version_id, rs.origin, rs.added_at, s.id AS scorer_id, s.name, s.kind, sv.version
         FROM run_scorers rs JOIN scorer_versions sv ON sv.id = rs.scorer_version_id JOIN scorers s ON s.id = sv.scorer_id
        WHERE rs.run_id = $1 ORDER BY rs.added_at, s.name, sv.version`,
      [runId],
    ),
    db.query<{ input_tokens: number | null; output_tokens: number | null; avg_queue: number | null; avg_ttft: number | null; avg_gen: number | null; calls: number; live: number }>(
      `SELECT sum(input_tokens)::int AS input_tokens, sum(output_tokens)::int AS output_tokens,
              avg(queue_ms) FILTER (WHERE status = 'succeeded') AS avg_queue, avg(ttft_ms) AS avg_ttft, avg(generation_ms) AS avg_gen,
              (SELECT count(*) FROM case_attempts a JOIN case_results c2 ON c2.id = a.case_result_id WHERE c2.run_id = $1) AS calls,
              count(*) FILTER (WHERE status = 'running' AND lease_expires_at > now()) AS live
         FROM case_results WHERE run_id = $1`,
      [runId],
    ),
  ])
  const progress: Record<TaskStatus, number> = { pending: 0, running: 0, succeeded: 0, errored: 0, cancelled: 0 }
  for (const t of tasks.rows) progress[t.status]++
  const byScorer = new Map<string, Map<string, { status: string; score: number | null; passed: boolean | null }>>()
  for (const s of scores.rows) {
    let m = byScorer.get(s.scorer_version_id)
    if (!m) byScorer.set(s.scorer_version_id, (m = new Map()))
    m.set(s.case_result_id, s)
  }
  const out: RunScorer[] = scorers.rows.map((sc) => {
    const m = byScorer.get(sc.scorer_version_id) ?? new Map()
    const rows: SampleRow[] = tasks.rows.map((t) => {
      const s = m.get(t.id)
      const scored = s && s.status === 'scored'
      return { caseKey: t.case_key, sampleIndex: t.sample_index, status: t.status, score: scored ? s.score : null, passed: scored ? s.passed : null }
    })
    const coverage = { scored: 0, pending: 0, errored: 0, cancelled: 0 }
    for (const s of m.values()) {
      if (s.status === 'scored') coverage.scored++
      else if (s.status === 'pending' || s.status === 'running') coverage.pending++
      else if (s.status === 'errored') coverage.errored++
      else coverage.cancelled++
    }
    return {
      scorerVersionId: sc.scorer_version_id,
      scorerId: sc.scorer_id,
      name: sc.name,
      kind: sc.kind,
      version: sc.version,
      origin: sc.origin,
      addedAt: sc.added_at.toISOString(),
      coverage,
      complete: coverage.pending === 0 && coverage.scored + coverage.errored >= progress.succeeded && progress.succeeded > 0,
      aggregate: aggregateRun(rows),
    }
  })
  const u = usage.rows[0]
  const round = (x: number | null) => (x === null ? null : Math.round(x))
  return {
    progress,
    usage: {
      inputTokens: u?.input_tokens ?? 0,
      outputTokens: u?.output_tokens ?? 0,
      modelCalls: u?.calls ?? 0,
      avgQueueMs: round(u?.avg_queue ?? null),
      avgTtftMs: round(u?.avg_ttft ?? null),
      avgGenerationMs: round(u?.avg_gen ?? null),
      liveLeases: u?.live ?? 0,
    },
    scorers: out,
  }
}

/** Sample rows for one scorer version, for pairing and the e2e's independent recomputation. */
export async function loadScoredRows(db: Queryable, runId: string, scorerVersionId: string): Promise<SampleRow[]> {
  const { rows } = await db.query<{ case_key: string; sample_index: number; status: TaskStatus; score: number | null; passed: boolean | null }>(
    `SELECT cr.case_key, cr.sample_index, cr.status, s.score, s.passed
       FROM case_results cr
       LEFT JOIN scores s ON s.case_result_id = cr.id AND s.scorer_version_id = $2 AND s.status = 'scored'
      WHERE cr.run_id = $1`,
    [runId, scorerVersionId],
  )
  return rows.map((r) => ({ caseKey: r.case_key, sampleIndex: r.sample_index, status: r.status, score: r.score, passed: r.passed }))
}
