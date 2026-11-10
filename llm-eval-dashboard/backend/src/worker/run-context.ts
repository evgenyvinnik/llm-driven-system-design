/**
 * Everything a worker needs to execute a task, read once and cached. Safe to
 * cache forever: a run's pins point at immutable rows (prompt version, model
 * config, dataset cases, scorer versions pinned at creation).
 * @module worker/run-context
 */
import type { Queryable } from '../shared/db.js'
import type { ScorerKind } from '../shared/scorers.js'

export interface RunContext {
  runId: string
  system: string
  template: string
  model: string
  temperature: number
  maxTokens: number
  seed: number
  /** Scorer versions pinned at creation (not human: those come from annotations). */
  scorers: { id: string; kind: ScorerKind; config: Record<string, unknown> }[]
}

export interface CaseData {
  input: Record<string, unknown>
  reference: string
}

const runs = new Map<string, RunContext>()
const cases = new Map<string, CaseData>()

export async function loadRunContext(db: Queryable, runId: string): Promise<RunContext> {
  const cached = runs.get(runId)
  if (cached) return cached
  const { rows } = await db.query<{ system_text: string; template: string; model: string; temperature: number; max_tokens: number; seed: number }>(
    `SELECT pv.system_text, pv.template, mc.model, mc.temperature, mc.max_tokens, mc.seed
       FROM eval_runs r
       JOIN prompt_versions pv ON pv.id = r.prompt_version_id
       JOIN model_configs mc ON mc.id = r.model_config_id
      WHERE r.id = $1`,
    [runId],
  )
  if (!rows[0]) throw new Error(`run ${runId} not found`)
  const scorers = await db.query<{ id: string; kind: ScorerKind; config: Record<string, unknown> }>(
    `SELECT sv.id, s.kind, sv.config
       FROM run_scorers rs JOIN scorer_versions sv ON sv.id = rs.scorer_version_id JOIN scorers s ON s.id = sv.scorer_id
      WHERE rs.run_id = $1 AND rs.origin = 'pinned' AND s.kind <> 'human'`,
    [runId],
  )
  const r = rows[0]
  const ctx: RunContext = { runId, system: r.system_text, template: r.template, model: r.model, temperature: r.temperature, maxTokens: r.max_tokens, seed: r.seed, scorers: scorers.rows }
  runs.set(runId, ctx)
  return ctx
}

export async function loadCase(db: Queryable, caseId: string): Promise<CaseData> {
  const cached = cases.get(caseId)
  if (cached) return cached
  const { rows } = await db.query<{ input: Record<string, unknown>; reference: string }>('SELECT input, reference FROM dataset_cases WHERE id = $1', [caseId])
  if (!rows[0]) throw new Error(`case ${caseId} not found`)
  cases.set(caseId, rows[0])
  if (cases.size > 50_000) cases.clear()
  return rows[0]
}
