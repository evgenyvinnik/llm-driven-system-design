/**
 * Workspace model presets. Edits use optimistic concurrency: the client sends
 * the revision it loaded in If-Match, and a stale revision gets 409 with the
 * current preset, so two people editing the same preset never silently
 * overwrite each other.
 */
import type { Request } from 'express'
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../../shared/auth.js'
import { modelConfigSchema } from '../../shared/catalog.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { uuidParam } from '../../shared/ids.js'

export const presetsRouter = Router()
presetsRouter.use(requireAuth)

const createSchema = z.object({ name: z.string().trim().min(1).max(80), config: modelConfigSchema }).strict()
const updateSchema = z
  .object({ name: z.string().trim().min(1).max(80).optional(), config: modelConfigSchema.optional() })
  .strict()

interface PresetRow {
  id: string
  name: string
  config: unknown
  revision: number
  updated_at: Date
  updated_by_name: string
}

const PRESET_SELECT = `SELECT p.id, p.name, p.config, p.revision, p.updated_at, u.display_name AS updated_by_name
  FROM model_presets p JOIN users u ON u.id = p.updated_by`

const serialize = (p: PresetRow) => ({
  id: p.id,
  name: p.name,
  config: p.config,
  revision: p.revision,
  updatedBy: p.updated_by_name,
  updatedAt: p.updated_at.toISOString(),
})

function ifMatchRevision(req: Request): number {
  const header = req.get('If-Match')
  if (!header) throw new HttpError(428, 'PRECONDITION_REQUIRED', 'Send If-Match with the revision you edited')
  const revision = Number(header.replace(/^W\//, '').replace(/"/g, ''))
  if (!Number.isInteger(revision)) throw new HttpError(400, 'INVALID_IF_MATCH', 'If-Match must be a revision number')
  return revision
}

async function loadPreset(id: string, workspaceId: string): Promise<PresetRow> {
  const { rows } = await pool.query<PresetRow>(`${PRESET_SELECT} WHERE p.id = $1 AND p.workspace_id = $2`, [
    id,
    workspaceId,
  ])
  if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Preset not found')
  return rows[0]
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'
}

presetsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query<PresetRow>(`${PRESET_SELECT} WHERE p.workspace_id = $1 ORDER BY p.name`, [
      req.user!.workspaceId,
    ])
    res.json({ presets: rows.map(serialize) })
  }),
)

presetsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body)
    try {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO model_presets (workspace_id, name, config, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $4) RETURNING id`,
        [req.user!.workspaceId, body.name, JSON.stringify(body.config), req.user!.id],
      )
      const preset = await loadPreset(rows[0].id, req.user!.workspaceId)
      res.status(201).setHeader('ETag', `"${preset.revision}"`).json({ preset: serialize(preset) })
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'NAME_TAKEN', `A preset named "${body.name}" already exists`)
      throw err
    }
  }),
)

presetsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = uuidParam(req.params.id, 'Preset')
    const revision = ifMatchRevision(req)
    const body = updateSchema.parse(req.body)
    let updated
    try {
      updated = await pool.query(
        `UPDATE model_presets
            SET name = coalesce($4, name), config = coalesce($5, config), revision = revision + 1,
                updated_by = $6, updated_at = now()
          WHERE id = $1 AND workspace_id = $2 AND revision = $3
          RETURNING id`,
        [id, req.user!.workspaceId, revision, body.name ?? null, body.config ? JSON.stringify(body.config) : null, req.user!.id],
      )
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'NAME_TAKEN', `A preset named "${body.name}" already exists`)
      throw err
    }
    if (updated.rowCount === 0) {
      const current = await loadPreset(id, req.user!.workspaceId)
      throw new HttpError(
        409,
        'REVISION_CONFLICT',
        `${current.updated_by_name} changed this preset after you loaded it`,
        { current: serialize(current) },
      )
    }
    const preset = await loadPreset(id, req.user!.workspaceId)
    res.setHeader('ETag', `"${preset.revision}"`).json({ preset: serialize(preset) })
  }),
)

presetsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = uuidParam(req.params.id, 'Preset')
    const revision = ifMatchRevision(req)
    const deleted = await pool.query(
      'DELETE FROM model_presets WHERE id = $1 AND workspace_id = $2 AND revision = $3',
      [id, req.user!.workspaceId, revision],
    )
    if (deleted.rowCount === 0) {
      const current = await loadPreset(id, req.user!.workspaceId)
      throw new HttpError(409, 'REVISION_CONFLICT', `${current.updated_by_name} changed this preset after you loaded it`, {
        current: serialize(current),
      })
    }
    res.status(204).end()
  }),
)
