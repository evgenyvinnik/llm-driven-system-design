import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRepoAdmin, userOf } from '../../shared/auth.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, notFound } from '../../shared/errors.js'
import { MODEL_VERSIONS } from '../../shared/repos.js'
import { runEvaluation, type EvaluationRow } from '../../evaluation/service.js'

export const evaluationsRouter = Router()
evaluationsRouter.use(requireAuth)

const dto = (e: EvaluationRow) => ({
  id: e.id,
  status: e.status,
  modelVersion: e.model_version,
  policyVersion: e.policy_version,
  corpusHash: e.corpus_hash,
  corpusSize: e.corpus_size,
  partial: e.partial,
  summary: e.summary,
  createdBy: e.created_by,
  createdAt: e.created_at.toISOString(),
  finishedAt: e.finished_at?.toISOString() ?? null,
})

evaluationsRouter.get(
  '/evaluations',
  asyncHandler(async (_req, res) => {
    const rows = await pool.query<EvaluationRow>(`SELECT * FROM evaluations ORDER BY created_at DESC LIMIT 50`)
    res.json({ evaluations: rows.rows.map(dto), modelVersions: MODEL_VERSIONS })
  }),
)

const createBody = z.object({ modelVersion: z.enum(MODEL_VERSIONS), limit: z.number().int().min(1).max(10_000).optional() }).strict()

evaluationsRouter.post(
  '/evaluations',
  requireRepoAdmin,
  asyncHandler(async (req, res) => {
    const body = createBody.parse(req.body)
    res.status(201).json({ evaluation: dto(await runEvaluation({ ...body, createdBy: userOf(req).username })) })
  }),
)

evaluationsRouter.get(
  '/evaluations/:id',
  asyncHandler(async (req, res) => {
    const found = await pool.query<EvaluationRow>(`SELECT * FROM evaluations WHERE id = $1`, [req.params.id])
    if (!found.rows[0]) throw notFound('Evaluation')
    const cases = await pool.query(`SELECT * FROM evaluation_cases WHERE evaluation_id = $1 ORDER BY dangerous DESC, class, case_id`, [req.params.id])
    res.json({
      evaluation: dto(found.rows[0]),
      cases: cases.rows.map((c) => ({
        caseId: c.case_id,
        title: c.title,
        class: c.class,
        dangerous: c.dangerous,
        injection: c.injection,
        humanDecision: c.human_decision,
        inScope: c.in_scope,
        modelVerdict: c.model_verdict,
        modelConfidence: c.model_confidence,
        modelOnly: c.model_only,
        gated: c.gated,
        observeWould: c.observe_would,
        reasonCode: c.reason_code,
        reason: c.reason,
        failedRules: c.failed_rules,
        toolsDenied: c.tools_denied,
        scannerHit: c.scanner_hit,
      })),
    })
  }),
)
