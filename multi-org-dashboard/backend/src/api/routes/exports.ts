/**
 * Conversation exports as background jobs. Creating one is idempotent per
 * (org, user, Idempotency-Key); the worker re-checks the creator's access
 * before it starts and before it finishes; downloading re-checks again,
 * against PostgreSQL, because a file is a copy of data that outlives the cache.
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { z } from 'zod'
import { writeAudit } from '../../shared/audit.js'
import { conversationFiltersSchema } from '../../shared/conversation-query.js'
import { pool, withTransaction } from '../../shared/db.js'
import { asyncHandler, HttpError, notFound } from '../../shared/errors.js'
import { uuidParam } from '../../shared/ids.js'
import { accessOf, orgRoutes } from '../../shared/org-access.js'
import type { EffectiveAccess } from '../../shared/access.js'

export const exportsRouter = orgRoutes()

export function mapExport(r: Record<string, unknown>) {
  return {
    id: r.id,
    kind: r.kind,
    query: r.query,
    status: r.status,
    totalRows: r.total_rows,
    processedRows: r.processed_rows,
    fileBytes: r.file_bytes === null ? null : Number(r.file_bytes),
    errorCode: r.error_code,
    errorMessage: r.error_message,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    createdByName: r.created_by_name,
  }
}

const EXPORT_SELECT = `
  SELECT j.*, u.display_name AS created_by_name
    FROM export_jobs j JOIN users u ON u.id = j.created_by`

/** Admins see every export in the org; others see their own. */
function ownerScope(access: EffectiveAccess, firstParam: number) {
  return access.role === 'admin' ? 'TRUE' : `j.created_by = $${firstParam}`
}

exportsRouter.get(
  '/exports',
  { permission: 'conversations.export' },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const { rows } = await pool.query(
      `${EXPORT_SELECT} WHERE j.org_id = $1 AND ${ownerScope(access, 2)} ORDER BY j.created_at DESC LIMIT 50`,
      access.role === 'admin' ? [access.orgId] : [access.orgId, access.userId],
    )
    res.json({ exports: rows.map(mapExport) })
  }),
)

exportsRouter.get(
  '/exports/:exportId',
  { permission: 'conversations.export' },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const id = uuidParam(req.params.exportId, 'Export')
    const { rows } = await pool.query(
      `${EXPORT_SELECT} WHERE j.id = $1 AND j.org_id = $2 AND ${ownerScope(access, 3)}`,
      access.role === 'admin' ? [id, access.orgId] : [id, access.orgId, access.userId],
    )
    if (!rows[0]) throw notFound('Export')
    res.json({ export: mapExport(rows[0]) })
  }),
)

/** Filters are flat, so sorting the keys is enough to compare a stored JSONB value with a request body. */
const canonical = (filters: object) => JSON.stringify(Object.fromEntries(Object.entries(filters).sort()))

const createExportSchema = z.object({ kind: z.literal('conversations'), filters: conversationFiltersSchema }).strict()
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/

exportsRouter.post(
  '/exports',
  { permission: 'conversations.export', entitlement: 'exports' },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const key = req.header('Idempotency-Key')
    if (!key || !IDEMPOTENCY_KEY.test(key)) {
      throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (8-100 URL-safe characters)')
    }
    const body = createExportSchema.parse(req.body)
    const { job, created } = await withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO export_jobs (org_id, created_by, kind, query, idempotency_key)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (org_id, created_by, idempotency_key) DO NOTHING
         RETURNING id`,
        [access.orgId, access.userId, body.kind, JSON.stringify(body.filters), key],
      )
      if (inserted.rows[0]) {
        await writeAudit(client, {
          orgId: access.orgId,
          actor: req.user!,
          action: 'export.created',
          targetType: 'export',
          targetId: inserted.rows[0].id,
          targetName: body.kind,
          after: { filters: body.filters },
        })
      }
      const { rows } = await client.query(
        `${EXPORT_SELECT} WHERE j.org_id = $1 AND j.created_by = $2 AND j.idempotency_key = $3`,
        [access.orgId, access.userId, key],
      )
      return { job: rows[0], created: Boolean(inserted.rows[0]) }
    })
    // A retry with the same key and a different body is a client bug, not a second export.
    if (!created && canonical(job.query) !== canonical(body.filters)) {
      throw new HttpError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was used for a different export')
    }
    if (!created) res.setHeader('Idempotent-Replayed', 'true')
    res.status(created ? 202 : 200).json({ export: mapExport(job) })
  }),
)

exportsRouter.post(
  '/exports/:exportId/cancel',
  { permission: 'conversations.export' },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const id = uuidParam(req.params.exportId, 'Export')
    const { rows } = await pool.query(
      `UPDATE export_jobs j
          SET cancel_requested_at = now(),
              status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
              finished_at = CASE WHEN status = 'queued' THEN now() ELSE finished_at END
        WHERE j.id = $1 AND j.org_id = $2 AND ${ownerScope(access, 3)} AND j.status IN ('queued', 'running')
        RETURNING j.status`,
      access.role === 'admin' ? [id, access.orgId] : [id, access.orgId, access.userId],
    )
    if (!rows[0]) throw notFound('Active export')
    res.status(202).json({ status: rows[0].status })
  }),
)

exportsRouter.get(
  '/exports/:exportId/download',
  { permission: 'conversations.export', entitlement: 'exports', authoritative: true },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const id = uuidParam(req.params.exportId, 'Export')
    const { rows } = await pool.query(
      `SELECT j.file_path, j.created_at FROM export_jobs j
        WHERE j.id = $1 AND j.org_id = $2 AND j.status = 'completed' AND ${ownerScope(access, 3)}`,
      access.role === 'admin' ? [id, access.orgId] : [id, access.orgId, access.userId],
    )
    const job = rows[0]
    if (!job?.file_path) throw notFound('Export file')
    const info = await stat(job.file_path).catch(() => null)
    if (!info) throw new HttpError(410, 'EXPORT_EXPIRED', 'This export file is no longer available; run the export again')
    const date = (job.created_at as Date).toISOString().slice(0, 10)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Length', String(info.size))
    res.setHeader('Content-Disposition', `attachment; filename="conversations-${access.orgId}-${date}.csv"`)
    res.setHeader('Cache-Control', 'private, no-store')
    createReadStream(job.file_path).pipe(res)
  }),
)
