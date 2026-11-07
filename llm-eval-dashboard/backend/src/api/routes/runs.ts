/**
 * Eval runs: create (idempotent), list, detail, cases, attempts, cancel,
 * retry errored, re-score, annotations, and comparisons.
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, userOf, workspaceOf } from '../../shared/auth.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { annotationQueue, annotationSchema, saveAnnotation } from '../services/annotations.js'
import { loadAttempts, loadCaseTable } from '../services/cases.js'
import { compareRuns } from '../services/compare.js'
import { listRunHeaders, loadRunHeader, loadRunResults, loadScoredRows } from '../services/results.js'
import { cancelRun, createRun, createRunSchema, rescoreRun, retryErrored } from '../services/runs.js'

export const runsRouter = Router()
runsRouter.use(requireAuth)

runsRouter.get(
  '/runs',
  asyncHandler(async (req, res) => {
    const headers = await listRunHeaders(pool, workspaceOf(req))
    const runs = await Promise.all(
      headers.map(async (h) => {
        const r = await loadRunResults(pool, h.id)
        const primary = r.scorers.find((s) => s.origin === 'pinned' && s.kind !== 'human') ?? r.scorers[0] ?? null
        return { ...h, progress: r.progress, primary: primary ? { name: primary.name, version: primary.version, aggregate: primary.aggregate } : null }
      }),
    )
    res.json({ runs })
  }),
)

runsRouter.post(
  '/runs',
  asyncHandler(async (req, res) => {
    const key = req.get('idempotency-key')?.trim()
    if (!key || key.length > 200) throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (1-200 characters) so a retried request cannot start a second run')
    const user = userOf(req)
    const result = await createRun(user.workspaceId, user.id, key, createRunSchema.parse(req.body))
    const run = await loadRunHeader(pool, user.workspaceId, result.runId)
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true')
    res.status(result.replayed ? 200 : 201).json({ run, replayed: result.replayed })
  }),
)

runsRouter.get(
  '/runs/:id',
  asyncHandler(async (req, res) => {
    const run = await loadRunHeader(pool, workspaceOf(req), req.params.id)
    const results = await loadRunResults(pool, run.id)
    // Same pins except the sample count: shows how more samples narrow the interval.
    const siblings = await pool.query<{ id: string; name: string; samples_per_case: number; status: string }>(
      `SELECT id, name, samples_per_case, status FROM eval_runs
        WHERE workspace_id = $1 AND dataset_version_id = $2 AND prompt_version_id = $3 AND model_config_id = $4 ORDER BY samples_per_case, created_at`,
      [workspaceOf(req), run.dataset.versionId, run.prompt.versionId, run.modelConfig.id],
    )
    const samePins = await Promise.all(
      siblings.rows.map(async (s) => {
        const r = s.id === run.id ? results : await loadRunResults(pool, s.id)
        return { id: s.id, name: s.name, samplesPerCase: s.samples_per_case, status: s.status, scorers: r.scorers.map((x) => ({ scorerVersionId: x.scorerVersionId, mean: x.aggregate.mean, ciHalfWidth: x.aggregate.ciHalfWidth })) }
      }),
    )
    res.json({ run, ...results, samePins })
  }),
)

runsRouter.get(
  '/runs/:id/cases',
  asyncHandler(async (req, res) => {
    const run = await loadRunHeader(pool, workspaceOf(req), req.params.id)
    res.json({ cases: await loadCaseTable(pool, run.id) })
  }),
)

runsRouter.get(
  '/runs/:id/rows',
  asyncHandler(async (req, res) => {
    const run = await loadRunHeader(pool, workspaceOf(req), req.params.id)
    const scorerVersionId = z.string().min(1).parse(req.query.scorerVersionId)
    res.json({ rows: await loadScoredRows(pool, run.id, scorerVersionId) })
  }),
)

runsRouter.get(
  '/runs/:id/case-results/:crId/attempts',
  asyncHandler(async (req, res) => {
    const run = await loadRunHeader(pool, workspaceOf(req), req.params.id)
    res.json({ attempts: await loadAttempts(pool, run.id, req.params.crId) })
  }),
)

runsRouter.post('/runs/:id/cancel', asyncHandler(async (req, res) => res.json(await cancelRun(workspaceOf(req), req.params.id))))
runsRouter.post('/runs/:id/retry-errored', asyncHandler(async (req, res) => res.json(await retryErrored(workspaceOf(req), req.params.id))))
runsRouter.post(
  '/runs/:id/rescore',
  asyncHandler(async (req, res) => {
    const { scorerVersionId } = z.object({ scorerVersionId: z.string().min(1) }).strict().parse(req.body)
    const user = userOf(req)
    res.status(202).json(await rescoreRun(user.workspaceId, user.id, req.params.id, scorerVersionId))
  }),
)

runsRouter.get('/runs/:id/annotations', asyncHandler(async (req, res) => res.json(await annotationQueue(pool, workspaceOf(req), req.params.id))))
runsRouter.put(
  '/runs/:id/annotations/:crId',
  asyncHandler(async (req, res) => {
    const user = userOf(req)
    res.json(await saveAnnotation(user.workspaceId, user.id, req.params.id, req.params.crId, annotationSchema.parse(req.body)))
  }),
)

runsRouter.get(
  '/compare',
  asyncHandler(async (req, res) => {
    const q = z.object({ a: z.string().min(1), b: z.string().min(1), scorer: z.string().min(1) }).parse(req.query)
    res.json(await compareRuns(pool, workspaceOf(req), q.a, q.b, q.scorer))
  }),
)
