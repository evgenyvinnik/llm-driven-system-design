/**
 * Exports run as background jobs. The browser only creates the job (with an
 * idempotency key, so a retried click creates one job), polls its progress,
 * and downloads the finished file.
 *
 * The columns are fixed at creation from the requester's permissions and
 * checked again at download, so an admin demoted after creating an export
 * cannot then download its cost column.
 */
import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireOrgAccess } from '../../shared/auth.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError, notFound } from '../../shared/errors.js'
import { exportColumns, type ExportKind } from '../../exporter/columns.js'
import { parseFilters } from '../services/query-spec.js'

export const exportsRouter = Router()
exportsRouter.use(requireAuth)

interface JobRow {
  id: string
  org_id: string
  kind: ExportKind
  query: Record<string, unknown>
  columns: string[]
  status: string
  rows_total: string | null
  rows_done: string
  file_bytes: string | null
  error: string | null
  created_at: Date
  started_at: Date | null
  finished_at: Date | null
  expires_at: Date | null
}

function toDto(r: JobRow) {
  return {
    id: r.id,
    org: r.org_id,
    kind: r.kind,
    query: r.query,
    columns: r.columns,
    status: r.status,
    rowsTotal: r.rows_total === null ? null : Number(r.rows_total),
    rowsDone: Number(r.rows_done),
    fileBytes: r.file_bytes === null ? null : Number(r.file_bytes),
    error: r.error,
    createdAt: r.created_at.toISOString(),
    startedAt: r.started_at?.toISOString() ?? null,
    finishedAt: r.finished_at?.toISOString() ?? null,
    expiresAt: r.expires_at?.toISOString() ?? null,
  }
}

const createSchema = z.object({
  kind: z.enum(['daily_metrics', 'conversations']),
  query: z.record(z.string(), z.string()),
})

exportsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const key = req.header('Idempotency-Key')
    if (!key || key.length > 100) throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header')
    const body = createSchema.parse(req.body)
    const access = await requireOrgAccess(req.user!, body.query.org ?? '', 'export:create')
    const filters = parseFilters(body.query, access.timeZone)
    if (body.kind === 'conversations' && !access.permissions.includes('drilldown:read')) {
      throw new HttpError(403, 'FORBIDDEN', 'Your role cannot export conversation lists')
    }
    const columns = exportColumns(body.kind, access.permissions)
    const query = {
      org: filters.org,
      from: new Date(filters.from).toISOString(),
      to: new Date(filters.to).toISOString(),
      grain: filters.grain,
      models: filters.models.join(','),
      features: filters.features.join(','),
      compare: filters.compare,
    }
    const { rows } = await pool.query<JobRow>(
      `INSERT INTO export_jobs (id, user_id, org_id, idempotency_key, kind, query, columns)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [randomUUID(), req.user!.id, filters.org, key, body.kind, query, columns],
    )
    if (rows[0]) {
      res.status(202).json(toDto(rows[0]))
      return
    }
    // Same key again: return the job the first request created.
    const existing = await pool.query<JobRow>('SELECT * FROM export_jobs WHERE user_id = $1 AND idempotency_key = $2', [req.user!.id, key])
    res.status(200).json(toDto(existing.rows[0]))
  }),
)

exportsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query<JobRow>(
      'SELECT * FROM export_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.user!.id],
    )
    res.json({ jobs: rows.map(toDto) })
  }),
)

async function ownJob(userId: string, id: string): Promise<JobRow> {
  if (!z.string().uuid().safeParse(id).success) throw notFound('Export')
  const { rows } = await pool.query<JobRow>('SELECT * FROM export_jobs WHERE id = $1 AND user_id = $2', [id, userId])
  if (!rows[0]) throw notFound('Export')
  return rows[0]
}

exportsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(toDto(await ownJob(req.user!.id, req.params.id)))
  }),
)

exportsRouter.get(
  '/:id/download',
  asyncHandler(async (req, res) => {
    const job = await ownJob(req.user!.id, req.params.id)
    if (job.status !== 'succeeded') throw new HttpError(409, 'NOT_READY', `Export is ${job.status}`)
    const access = await requireOrgAccess(req.user!, job.org_id, 'export:create')
    if (job.columns.includes('cost_usd') && !access.permissions.includes('billing:read')) {
      throw new HttpError(403, 'FORBIDDEN', 'This export contains billing columns your role can no longer see')
    }
    const { rows } = await pool.query<{ file_path: string }>('SELECT file_path FROM export_jobs WHERE id = $1', [job.id])
    const path = rows[0]?.file_path
    if (!path || !existsSync(path)) throw new HttpError(410, 'EXPIRED', 'The export file is no longer available')
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${job.org_id}-${job.kind}-${job.id.slice(0, 8)}.csv"`)
    createReadStream(path).pipe(res)
  }),
)
