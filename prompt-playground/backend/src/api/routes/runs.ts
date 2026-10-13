import { Router } from 'express'
import { requireAuth } from '../../shared/auth.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { uuidParam } from '../../shared/ids.js'
import {
  cancelRun,
  createRun,
  createRunSchema,
  loadRunForUser,
  RUN_SELECT,
  serializeRun,
  type RunRow,
} from '../services/runs.js'
import { streamRunEvents } from '../services/run-stream.js'

// Mounted at /api/v1 alongside the public share routes, so auth is per route
// rather than router.use(), which would also run for requests that fall through.
export const runsRouter = Router()

/**
 * Starts a run. Requires an Idempotency-Key header (one per click in the UI):
 * a retry after a lost response returns the same run with 200 instead of
 * starting a second generation.
 */
runsRouter.post(
  '/runs',
  requireAuth,
  asyncHandler(async (req, res) => {
    const key = req.get('Idempotency-Key')
    if (!key || key.length > 100) {
      throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (1-100 characters)')
    }
    const input = createRunSchema.parse(req.body)
    const { row, replayed } = await createRun(req.user!, input, key)
    if (replayed) res.setHeader('Idempotent-Replayed', 'true')
    res.status(replayed ? 200 : 202).json({ run: serializeRun(row) })
  }),
)

/** The caller's queued and running runs across all prompts, so a refreshed tab can reattach. */
runsRouter.get(
  '/runs/active',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query<RunRow>(
      `${RUN_SELECT} WHERE r.created_by = $1 AND r.status IN ('queued', 'running') ORDER BY r.created_at`,
      [req.user!.id],
    )
    const titles = await pool.query<{ id: string; title: string }>('SELECT id, title FROM prompts WHERE id = ANY($1)', [
      [...new Set(rows.map((r) => r.prompt_id))],
    ])
    const titleById = new Map(titles.rows.map((t) => [t.id, t.title]))
    res.json({
      runs: rows.map((r) => ({ ...serializeRun(r, { includeOutput: false }), promptTitle: titleById.get(r.prompt_id) ?? '' })),
    })
  }),
)

runsRouter.get(
  '/runs/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const run = await loadRunForUser(pool, uuidParam(req.params.id, 'Run'), req.user!)
    res.json({ run: serializeRun(run) })
  }),
)

runsRouter.post(
  '/runs/:id/cancel',
  requireAuth,
  asyncHandler(async (req, res) => {
    const run = await cancelRun(req.user!, uuidParam(req.params.id, 'Run'))
    // 202 while the executor still has to acknowledge; 200 once the outcome is final.
    res.status(run.status === 'running' ? 202 : 200).json({ run: serializeRun(run) })
  }),
)

runsRouter.get(
  '/runs/:id/events',
  requireAuth,
  asyncHandler(async (req, res) => {
    const run = await loadRunForUser(pool, uuidParam(req.params.id, 'Run'), req.user!)
    const lastEventId = req.get('Last-Event-ID') ?? (typeof req.query.after === 'string' ? req.query.after : undefined)
    await streamRunEvents(req, res, run, lastEventId)
  }),
)

runsRouter.get(
  '/comparisons/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const comparisonId = uuidParam(req.params.id, 'Comparison')
    const { rows } = await pool.query<RunRow>(
      `${RUN_SELECT}
         JOIN workspace_members m ON m.workspace_id = r.workspace_id AND m.user_id = $2
        WHERE r.comparison_id = $1
        ORDER BY r.created_at`,
      [comparisonId, req.user!.id],
    )
    if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Comparison not found')
    res.json({ runs: rows.map((r) => serializeRun(r)) })
  }),
)
