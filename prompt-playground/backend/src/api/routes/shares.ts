/**
 * Share links. A link names one immutable thing (a saved version or a finished
 * run), so what a recipient sees never changes after the link is created.
 * Revoking a link takes effect on the next request; there is no cache.
 */
import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../../shared/auth.js'
import { pool, withTransaction } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { uuidParam } from '../../shared/ids.js'
import { isTerminal, type RunStatus } from '../../shared/run-events.js'
import { enforceRateLimit } from '../../shared/rate-limit.js'
import { loadPromptForUser, upsertSnapshot } from '../services/prompts.js'
import { loadRunForUser, runUsage, type RunRow } from '../services/runs.js'

export const sharesRouter = Router()

const createSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('version'), version: z.number().int().positive() }),
  z.object({ kind: z.literal('run'), runId: z.string().uuid() }),
])

const TOKEN = /^[A-Za-z0-9_-]{16,64}$/

sharesRouter.post(
  '/prompts/:id/shares',
  requireAuth,
  asyncHandler(async (req, res) => {
    const prompt = await loadPromptForUser(pool, uuidParam(req.params.id, 'Prompt'), req.user!)
    const body = createSchema.parse(req.body)
    let snapshotId: string
    let version: number | null = null
    let runId: string | null = null
    if (body.kind === 'version') {
      const { rows } = await pool.query<{ snapshot_id: string }>(
        'SELECT snapshot_id FROM prompt_versions WHERE prompt_id = $1 AND version = $2',
        [prompt.id, body.version],
      )
      if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Version not found')
      snapshotId = rows[0].snapshot_id
      version = body.version
    } else {
      const run = await loadRunForUser(pool, body.runId, req.user!)
      if (run.prompt_id !== prompt.id) throw new HttpError(404, 'NOT_FOUND', 'Run not found')
      if (!isTerminal(run.status)) throw new HttpError(409, 'RUN_NOT_FINISHED', 'Share a run after it finishes')
      snapshotId = run.snapshot_id
      version = run.version
      runId = run.id
    }
    const token = randomBytes(16).toString('base64url')
    await pool.query(
      `INSERT INTO shares (token, workspace_id, prompt_id, snapshot_id, version, run_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [token, prompt.workspace_id, prompt.id, snapshotId, version, runId, req.user!.id],
    )
    res.status(201).json({ share: { token, kind: body.kind, version, runId, path: `/s/${token}` } })
  }),
)

sharesRouter.get(
  '/prompts/:id/shares',
  requireAuth,
  asyncHandler(async (req, res) => {
    const prompt = await loadPromptForUser(pool, uuidParam(req.params.id, 'Prompt'), req.user!)
    const { rows } = await pool.query(
      `SELECT s.token, s.version, s.run_id, s.created_at, u.display_name
         FROM shares s JOIN users u ON u.id = s.created_by
        WHERE s.prompt_id = $1 AND s.revoked_at IS NULL
        ORDER BY s.created_at DESC`,
      [prompt.id],
    )
    res.json({
      shares: rows.map((s) => ({
        token: s.token,
        kind: s.run_id ? 'run' : 'version',
        version: s.version,
        runId: s.run_id,
        createdBy: s.display_name,
        createdAt: s.created_at.toISOString(),
        path: `/s/${s.token}`,
      })),
    })
  }),
)

sharesRouter.delete(
  '/shares/:token',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `UPDATE shares s SET revoked_at = now()
         FROM workspace_members m
        WHERE s.token = $1 AND s.revoked_at IS NULL AND m.workspace_id = s.workspace_id AND m.user_id = $2`,
      [req.params.token, req.user!.id],
    )
    if (result.rowCount === 0) throw new HttpError(404, 'NOT_FOUND', 'Share not found')
    res.status(204).end()
  }),
)

async function loadShared(token: string) {
  if (!TOKEN.test(token)) throw new HttpError(404, 'NOT_FOUND', 'Share not found')
  const { rows } = await pool.query(
    `SELECT s.*, p.title, u.display_name, sn.system_text, sn.template_text, sn.variables AS snapshot_variables
       FROM shares s
       JOIN prompts p ON p.id = s.prompt_id
       JOIN users u ON u.id = s.created_by
       JOIN prompt_snapshots sn ON sn.id = s.snapshot_id
      WHERE s.token = $1`,
    [token],
  )
  if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Share not found')
  if (rows[0].revoked_at) throw new HttpError(410, 'SHARE_REVOKED', 'This link was revoked')
  return rows[0]
}

/** Public, read-only. Exposes only the shared snapshot (and run), never the rest of the workspace. */
sharesRouter.get(
  '/shared/:token',
  asyncHandler(async (req, res) => {
    await enforceRateLimit(`shared:${req.ip}`, 120, 60)
    const s = await loadShared(req.params.token)
    let run = null
    if (s.run_id) {
      const { rows } = await pool.query<RunRow>('SELECT * FROM runs WHERE id = $1', [s.run_id])
      const r = rows[0]
      run = {
        model: r.model,
        config: r.config,
        variables: r.variables,
        status: r.status as RunStatus,
        output: r.output,
        outputTruncated: r.output_truncated,
        finishReason: r.finish_reason,
        errorMessage: r.error_message,
        usage: runUsage(r),
        createdAt: r.created_at.toISOString(),
      }
    }
    res.json({
      share: { token: s.token, kind: s.run_id ? 'run' : 'version', sharedBy: s.display_name, createdAt: s.created_at.toISOString() },
      prompt: { title: s.title },
      version: s.version,
      snapshot: { system: s.system_text, template: s.template_text, variables: s.snapshot_variables },
      run,
    })
  }),
)

/** Copies a shared prompt into the caller's workspace as a new prompt at version 1. */
sharesRouter.post(
  '/shared/:token/fork',
  requireAuth,
  asyncHandler(async (req, res) => {
    const s = await loadShared(req.params.token)
    const user = req.user!
    const promptId = await withTransaction(async (client) => {
      const created = await client.query<{ id: string }>(
        `INSERT INTO prompts (workspace_id, title, description, head_version, created_by, updated_by)
         VALUES ($1, $2, $3, 1, $4, $4) RETURNING id`,
        [user.workspaceId, `${s.title} (copy)`.slice(0, 200), `Copied from a shared link by ${s.display_name}`, user.id],
      )
      const id = created.rows[0].id
      const snapshot = await upsertSnapshot(client, id, s.system_text, s.template_text, user.id)
      await client.query(
        `INSERT INTO prompt_versions (prompt_id, version, snapshot_id, message, created_by)
         VALUES ($1, 1, $2, 'Copied from shared link', $3)`,
        [id, snapshot.id, user.id],
      )
      return id
    })
    res.status(201).json({ promptId })
  }),
)
