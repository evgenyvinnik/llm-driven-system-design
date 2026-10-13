import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireWorkspaceMember } from '../../shared/auth.js'
import { pool, withTransaction } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { uuidParam } from '../../shared/ids.js'
import { loadPromptForUser, loadVersion, upsertSnapshot, type PromptRow } from '../services/prompts.js'
import { RUN_SELECT, serializeRun, type RunRow } from '../services/runs.js'

export const promptsRouter = Router()
promptsRouter.use(requireAuth, asyncHandler(requireWorkspaceMember))

const createSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(2000).default(''),
    system: z.string().max(20_000).default(''),
    template: z.string().max(20_000).default(''),
  })
  .strict()

const updateSchema = z
  .object({ title: z.string().trim().min(1).max(200).optional(), description: z.string().max(2000).optional() })
  .strict()

const saveVersionSchema = z
  .object({
    system: z.string().max(20_000),
    template: z.string().min(1, 'The user message is empty').max(20_000),
    message: z.string().trim().max(500).default(''),
    /** The head version the editor started from. Saving fails with 409 if someone saved since. */
    baseVersion: z.number().int().min(0),
  })
  .strict()

function serializePrompt(p: PromptRow & { updated_by_name?: string; created_by_name?: string }) {
  return {
    id: p.id,
    workspaceId: p.workspace_id,
    title: p.title,
    description: p.description,
    headVersion: p.head_version,
    createdBy: { id: p.created_by, displayName: p.created_by_name ?? '' },
    updatedBy: { id: p.updated_by, displayName: p.updated_by_name ?? '' },
    createdAt: p.created_at.toISOString(),
    updatedAt: p.updated_at.toISOString(),
  }
}

async function promptDetail(promptId: string) {
  const { rows } = await pool.query(
    `SELECT p.*, cu.display_name AS created_by_name, uu.display_name AS updated_by_name
       FROM prompts p
       JOIN users cu ON cu.id = p.created_by
       JOIN users uu ON uu.id = p.updated_by
      WHERE p.id = $1`,
    [promptId],
  )
  const prompt = rows[0]
  const head = prompt.head_version > 0 ? await loadVersion(pool, promptId, prompt.head_version) : null
  const versions = await pool.query(
    `SELECT v.version, v.message, v.created_at, u.display_name
       FROM prompt_versions v JOIN users u ON u.id = v.created_by
      WHERE v.prompt_id = $1
      ORDER BY v.version DESC
      LIMIT 100`,
    [promptId],
  )
  return {
    prompt: serializePrompt(prompt),
    head,
    versions: versions.rows.map((v) => ({
      version: v.version,
      message: v.message,
      createdBy: v.display_name,
      createdAt: v.created_at.toISOString(),
    })),
  }
}

promptsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim().replace(/[\\%_]/g, '\\$&') : null
    const { rows } = await pool.query(
      `SELECT p.*, u.display_name AS updated_by_name,
              lr.id AS last_run_id, lr.status AS last_run_status, lr.model AS last_run_model,
              lr.created_at AS last_run_at,
              (SELECT count(*) FROM runs r WHERE r.prompt_id = p.id)::int AS run_count
         FROM prompts p
         JOIN users u ON u.id = p.updated_by
         LEFT JOIN LATERAL (
           SELECT id, status, model, created_at FROM runs WHERE prompt_id = p.id ORDER BY created_at DESC LIMIT 1
         ) lr ON true
        WHERE p.workspace_id = $1 AND ($2::text IS NULL OR p.title ILIKE '%' || $2 || '%')
        ORDER BY p.updated_at DESC
        LIMIT 200`,
      [req.user!.workspaceId, q],
    )
    res.json({
      prompts: rows.map((r) => ({
        ...serializePrompt(r),
        runCount: r.run_count,
        lastRun: r.last_run_id
          ? { id: r.last_run_id, status: r.last_run_status, model: r.last_run_model, createdAt: r.last_run_at.toISOString() }
          : null,
      })),
    })
  }),
)

promptsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body)
    const user = req.user!
    const promptId = await withTransaction(async (client) => {
      const created = await client.query<{ id: string }>(
        `INSERT INTO prompts (workspace_id, title, description, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $4) RETURNING id`,
        [user.workspaceId, body.title, body.description, user.id],
      )
      const id = created.rows[0].id
      if (body.template.trim()) {
        const snapshot = await upsertSnapshot(client, id, body.system, body.template, user.id)
        await client.query(
          `INSERT INTO prompt_versions (prompt_id, version, snapshot_id, message, created_by)
           VALUES ($1, 1, $2, 'Initial version', $3)`,
          [id, snapshot.id, user.id],
        )
        await client.query('UPDATE prompts SET head_version = 1 WHERE id = $1', [id])
      }
      return id
    })
    res.status(201).json(await promptDetail(promptId))
  }),
)

promptsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const prompt = await loadPromptForUser(pool, uuidParam(req.params.id, 'Prompt'), req.user!)
    res.json(await promptDetail(prompt.id))
  }),
)

/** Title and description are last-write-wins: they are labels, and losing a rename is cheap. */
promptsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const prompt = await loadPromptForUser(pool, uuidParam(req.params.id, 'Prompt'), req.user!)
    const body = updateSchema.parse(req.body)
    await pool.query(
      `UPDATE prompts SET title = coalesce($2, title), description = coalesce($3, description),
              updated_at = now(), updated_by = $4
        WHERE id = $1`,
      [prompt.id, body.title ?? null, body.description ?? null, req.user!.id],
    )
    res.json(await promptDetail(prompt.id))
  }),
)

promptsRouter.get(
  '/:id/versions/:version',
  asyncHandler(async (req, res) => {
    const prompt = await loadPromptForUser(pool, uuidParam(req.params.id, 'Prompt'), req.user!)
    const version = Number(req.params.version)
    const detail = Number.isInteger(version) ? await loadVersion(pool, prompt.id, version) : null
    if (!detail) throw new HttpError(404, 'NOT_FOUND', 'Version not found')
    res.json({ version: detail })
  }),
)

/**
 * Saves the editor's text as the next version. Versions are append-only, so
 * nothing can be overwritten; the 409 exists so a user saving on top of a
 * version they have never seen is told about it instead of silently
 * becoming the new head.
 */
promptsRouter.post(
  '/:id/versions',
  asyncHandler(async (req, res) => {
    const promptId = uuidParam(req.params.id, 'Prompt')
    const body = saveVersionSchema.parse(req.body)
    const user = req.user!
    const result = await withTransaction(async (client) => {
      const locked = await client.query<PromptRow>(
        `SELECT p.* FROM prompts p
           JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = $2
          WHERE p.id = $1
          FOR UPDATE OF p`,
        [promptId, user.id],
      )
      const prompt = locked.rows[0]
      if (!prompt) throw new HttpError(404, 'NOT_FOUND', 'Prompt not found')
      const snapshot = await upsertSnapshot(client, promptId, body.system, body.template, user.id)
      if (prompt.head_version > 0) {
        const head = await client.query<{ snapshot_id: string }>(
          'SELECT snapshot_id FROM prompt_versions WHERE prompt_id = $1 AND version = $2',
          [promptId, prompt.head_version],
        )
        // Saving the text that is already the head is a no-op, even with a stale
        // baseVersion. That makes a retried save idempotent: if the first attempt
        // committed but its response was lost, the retry returns that version.
        if (head.rows[0]?.snapshot_id === snapshot.id) {
          return { created: false, version: await loadVersion(client, promptId, prompt.head_version) }
        }
      }
      if (prompt.head_version !== body.baseVersion) {
        const head = await loadVersion(client, promptId, prompt.head_version)
        throw new HttpError(
          409,
          'HEAD_MOVED',
          `${head?.createdBy.displayName ?? 'Someone'} saved version ${prompt.head_version} after you started editing`,
          { head },
        )
      }
      const next = prompt.head_version + 1
      await client.query(
        `INSERT INTO prompt_versions (prompt_id, version, snapshot_id, message, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [promptId, next, snapshot.id, body.message, user.id],
      )
      await client.query(
        'UPDATE prompts SET head_version = $2, updated_at = now(), updated_by = $3 WHERE id = $1',
        [promptId, next, user.id],
      )
      return { created: true, version: await loadVersion(client, promptId, next) }
    })
    res.status(result.created ? 201 : 200).json(result)
  }),
)

promptsRouter.get(
  '/:id/runs',
  asyncHandler(async (req, res) => {
    const prompt = await loadPromptForUser(pool, uuidParam(req.params.id, 'Prompt'), req.user!)
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100)
    const before = typeof req.query.before === 'string' && !Number.isNaN(Date.parse(req.query.before))
      ? new Date(req.query.before)
      : null
    const { rows } = await pool.query<RunRow>(
      `${RUN_SELECT}
        WHERE r.prompt_id = $1 AND ($2::timestamptz IS NULL OR r.created_at < $2)
        ORDER BY r.created_at DESC
        LIMIT $3`,
      [prompt.id, before, limit + 1],
    )
    const page = rows.slice(0, limit)
    res.json({
      runs: page.map((r) => serializeRun(r, { includeOutput: false })),
      nextBefore: rows.length > limit ? page[page.length - 1].created_at.toISOString() : null,
    })
  }),
)
