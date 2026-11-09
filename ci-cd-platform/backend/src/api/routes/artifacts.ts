/**
 * Artifact download for people. The access check is here, on the bytes: there is no
 * presigned URL that outlives a membership. Bob gets a 404, carol (read-only) can download.
 * @module api/routes/artifacts
 */
import { Router } from 'express'
import { requireRepoRead } from '../../shared/access.js'
import { userOf } from '../../shared/auth.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError, notFound } from '../../shared/errors.js'
import { getBlob } from '../../shared/storage.js'

export const artifactsRouter = Router()

artifactsRouter.get(
  '/:artifactId/download',
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query<{ repo_id: string; name: string; object_key: string; sha256: string; deleted_at: Date | null; expires_at: Date; expired: boolean }>(
      'SELECT repo_id, name, object_key, sha256, deleted_at, expires_at, (deleted_at IS NOT NULL OR expires_at <= now()) AS expired FROM artifacts WHERE id = $1',
      [req.params.artifactId],
    )
    const artifact = rows[0]
    if (!artifact) throw notFound('Artifact')
    await requireRepoRead(pool, userOf(req), artifact.repo_id).catch(() => {
      throw notFound('Artifact')
    })
    if (artifact.expired) throw new HttpError(410, 'ARTIFACT_EXPIRED', 'This artifact is past its retention period')
    const bytes = await getBlob(artifact.object_key)
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${artifact.name}"`)
    res.setHeader('X-Content-SHA256', artifact.sha256)
    res.end(bytes)
  }),
)
