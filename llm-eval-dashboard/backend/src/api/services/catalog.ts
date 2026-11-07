/**
 * Prompts (immutable versions), model configs (immutable rows) and scorers
 * (immutable versions). A new version names its base; a stale base is a 409.
 * @module api/services/catalog
 */
import { z } from 'zod'
import { MODEL_IDS } from '../../model/catalog.js'
import { withTransaction, type Queryable } from '../../shared/db.js'
import { HttpError, notFound } from '../../shared/errors.js'
import { newId } from '../../shared/ids.js'
import { parseScorerConfig, SCORER_KINDS, type ScorerKind } from '../../shared/scorers.js'
import { extractVariables } from '../../shared/template.js'

export const promptVersionSchema = z
  .object({ baseVersion: z.number().int().min(0), system: z.string().max(20_000).default(''), template: z.string().min(1).max(50_000), message: z.string().trim().min(1).max(300) })
  .strict()
export const modelConfigSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    model: z.enum(MODEL_IDS),
    temperature: z.number().min(0).max(2),
    maxTokens: z.number().int().min(1).max(4096),
    seed: z.number().int().min(0).max(1_000_000),
  })
  .strict()
export const scorerVersionSchema = z.object({ baseVersion: z.number().int().min(0), config: z.record(z.unknown()), message: z.string().trim().min(1).max(300) }).strict()
export const createScorerSchema = z
  .object({ name: z.string().trim().min(1).max(100), kind: z.enum(SCORER_KINDS), description: z.string().max(500).default(''), config: z.record(z.unknown()) })
  .strict()

export async function listPrompts(db: Queryable, workspaceId: string) {
  const { rows } = await db.query<{ id: string; name: string; description: string; head_version: number; updated_at: Date; runs: number }>(
    `SELECT p.id, p.name, p.description, p.head_version, p.updated_at,
            (SELECT count(*) FROM eval_runs r JOIN prompt_versions v ON v.id = r.prompt_version_id WHERE v.prompt_id = p.id) AS runs
       FROM prompts p WHERE p.workspace_id = $1 ORDER BY p.name`,
    [workspaceId],
  )
  return rows.map((r) => ({ id: r.id, name: r.name, description: r.description, headVersion: r.head_version, updatedAt: r.updated_at.toISOString(), runs: r.runs }))
}

export async function getPrompt(db: Queryable, workspaceId: string, promptId: string) {
  const p = await db.query<{ id: string; name: string; description: string; head_version: number }>('SELECT id, name, description, head_version FROM prompts WHERE id = $1 AND workspace_id = $2', [promptId, workspaceId])
  if (!p.rows[0]) throw notFound('Prompt')
  const versions = await db.query<{ id: string; version: number; system_text: string; template: string; variables: string[]; message: string; created_at: Date; created_by: string; runs: number }>(
    `SELECT v.id, v.version, v.system_text, v.template, v.variables, v.message, v.created_at, u.display_name AS created_by,
            (SELECT count(*) FROM eval_runs r WHERE r.prompt_version_id = v.id) AS runs
       FROM prompt_versions v JOIN users u ON u.id = v.created_by WHERE v.prompt_id = $1 ORDER BY v.version DESC`,
    [promptId],
  )
  return {
    id: p.rows[0].id,
    name: p.rows[0].name,
    description: p.rows[0].description,
    headVersion: p.rows[0].head_version,
    versions: versions.rows.map((v) => ({ id: v.id, version: v.version, system: v.system_text, template: v.template, variables: v.variables, message: v.message, createdAt: v.created_at.toISOString(), createdBy: v.created_by, runs: v.runs })),
  }
}

export async function createPromptVersion(workspaceId: string, userId: string, promptId: string, input: z.infer<typeof promptVersionSchema>) {
  return withTransaction(async (client) => {
    const p = await client.query<{ head_version: number }>('SELECT head_version FROM prompts WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [promptId, workspaceId])
    if (!p.rows[0]) throw notFound('Prompt')
    const head = p.rows[0].head_version
    if (input.baseVersion !== head) throw new HttpError(409, 'VERSION_CONFLICT', `Prompt is at v${head}; you edited v${input.baseVersion}`, { headVersion: head })
    const id = newId('pv')
    await client.query('INSERT INTO prompt_versions (id, prompt_id, version, system_text, template, variables, message, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
      id,
      promptId,
      head + 1,
      input.system,
      input.template,
      extractVariables(input.system, input.template),
      input.message,
      userId,
    ])
    await client.query('UPDATE prompts SET head_version = $2, updated_at = now() WHERE id = $1', [promptId, head + 1])
    return { id, version: head + 1 }
  })
}

export async function listModelConfigs(db: Queryable, workspaceId: string) {
  const { rows } = await db.query<{ id: string; name: string; model: string; temperature: number; max_tokens: number; seed: number; created_at: Date }>(
    'SELECT id, name, model, temperature, max_tokens, seed, created_at FROM model_configs WHERE workspace_id = $1 ORDER BY created_at, name',
    [workspaceId],
  )
  return rows.map((r) => ({ id: r.id, name: r.name, model: r.model, temperature: r.temperature, maxTokens: r.max_tokens, seed: r.seed, createdAt: r.created_at.toISOString() }))
}

export async function createModelConfig(db: Queryable, workspaceId: string, userId: string, input: z.infer<typeof modelConfigSchema>) {
  const id = newId('mc')
  try {
    await db.query('INSERT INTO model_configs (id, workspace_id, name, model, temperature, max_tokens, seed, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [id, workspaceId, input.name, input.model, input.temperature, input.maxTokens, input.seed, userId])
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'NAME_TAKEN', 'A model config with this name exists; configs are immutable, so pick a new name')
    throw err
  }
  return { id }
}

export async function listScorers(db: Queryable, workspaceId: string) {
  const { rows } = await db.query<{ id: string; name: string; kind: ScorerKind; description: string; head_version: number; v_id: string; version: number; config: Record<string, unknown>; message: string; created_at: Date }>(
    `SELECT s.id, s.name, s.kind, s.description, s.head_version, v.id AS v_id, v.version, v.config, v.message, v.created_at
       FROM scorers s JOIN scorer_versions v ON v.scorer_id = s.id WHERE s.workspace_id = $1 ORDER BY s.name, v.version DESC`,
    [workspaceId],
  )
  const out = new Map<string, { id: string; name: string; kind: ScorerKind; description: string; headVersion: number; versions: { id: string; version: number; config: Record<string, unknown>; message: string; createdAt: string }[] }>()
  for (const r of rows) {
    let s = out.get(r.id)
    if (!s) out.set(r.id, (s = { id: r.id, name: r.name, kind: r.kind, description: r.description, headVersion: r.head_version, versions: [] }))
    s.versions.push({ id: r.v_id, version: r.version, config: r.config, message: r.message, createdAt: r.created_at.toISOString() })
  }
  return [...out.values()]
}

function validConfig(kind: ScorerKind, raw: unknown): Record<string, unknown> {
  try {
    return parseScorerConfig(kind, raw)
  } catch (err) {
    if (err instanceof SyntaxError) throw new HttpError(422, 'INVALID_REGEX', err.message)
    throw err
  }
}

export async function createScorer(workspaceId: string, userId: string, input: z.infer<typeof createScorerSchema>) {
  const cfg = validConfig(input.kind, input.config)
  return withTransaction(async (client) => {
    const id = newId('sc')
    try {
      await client.query('INSERT INTO scorers (id, workspace_id, name, kind, description, head_version, created_by) VALUES ($1, $2, $3, $4, $5, 1, $6)', [id, workspaceId, input.name, input.kind, input.description, userId])
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'NAME_TAKEN', 'A scorer with this name exists')
      throw err
    }
    const versionId = newId('scv')
    await client.query('INSERT INTO scorer_versions (id, scorer_id, version, config, message, created_by) VALUES ($1, $2, 1, $3, $4, $5)', [versionId, id, cfg, 'Initial version', userId])
    return { id, versionId, version: 1 }
  })
}

export async function createScorerVersion(workspaceId: string, userId: string, scorerId: string, input: z.infer<typeof scorerVersionSchema>) {
  return withTransaction(async (client) => {
    const s = await client.query<{ head_version: number; kind: ScorerKind }>('SELECT head_version, kind FROM scorers WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [scorerId, workspaceId])
    if (!s.rows[0]) throw notFound('Scorer')
    const { head_version: head, kind } = s.rows[0]
    if (input.baseVersion !== head) throw new HttpError(409, 'VERSION_CONFLICT', `Scorer is at v${head}; you edited v${input.baseVersion}`, { headVersion: head })
    const cfg = validConfig(kind, input.config)
    const id = newId('scv')
    await client.query('INSERT INTO scorer_versions (id, scorer_id, version, config, message, created_by) VALUES ($1, $2, $3, $4, $5, $6)', [id, scorerId, head + 1, cfg, input.message, userId])
    await client.query('UPDATE scorers SET head_version = $2 WHERE id = $1', [scorerId, head + 1])
    return { id, version: head + 1 }
  })
}

export const createPromptSchema = z
  .object({ name: z.string().trim().min(1).max(100), description: z.string().max(500).default(''), system: z.string().max(20_000).default(''), template: z.string().min(1).max(50_000) })
  .strict()

export async function createPrompt(workspaceId: string, userId: string, input: z.infer<typeof createPromptSchema>) {
  return withTransaction(async (client) => {
    const id = newId('pr')
    try {
      await client.query('INSERT INTO prompts (id, workspace_id, name, description, head_version, created_by) VALUES ($1, $2, $3, $4, 1, $5)', [id, workspaceId, input.name, input.description, userId])
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'NAME_TAKEN', 'A prompt with this name exists')
      throw err
    }
    const versionId = newId('pv')
    await client.query('INSERT INTO prompt_versions (id, prompt_id, version, system_text, template, variables, message, created_by) VALUES ($1, $2, 1, $3, $4, $5, $6, $7)', [
      versionId,
      id,
      input.system,
      input.template,
      extractVariables(input.system, input.template),
      'Initial version',
      userId,
    ])
    return { id, versionId, version: 1 }
  })
}
